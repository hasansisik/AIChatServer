const { User } = require("../models/User");
const Coupon = require("../models/Coupon");
const { StatusCodes } = require("http-status-codes");
const CustomError = require("../errors");

// Generate unique coupon code
const generateCouponCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'KM';
  
  // Generate exactly 4 characters after KM
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
};


// Create Coupon (Admin only)
const createCoupon = async (req, res, next) => {
  try {
    const {
      code,
      validUntil,
      usageLimit
    } = req.body;

    // Generate code if not provided
    let couponCode = code;
    if (!couponCode) {
      couponCode = generateCouponCode();
    }

    // Ensure code starts with KM
    if (!couponCode.toUpperCase().startsWith('KM')) {
      throw new CustomError.BadRequestError("Kupon kodu KM ile başlamalıdır");
    }

    // Check if code already exists
    const existingCoupon = await Coupon.findOne({ code: couponCode.toUpperCase() });
    if (existingCoupon) {
      throw new CustomError.BadRequestError("Bu kupon kodu zaten kullanılıyor");
    }

    // Create coupon
    const coupon = new Coupon({
      code: couponCode.toUpperCase(),
      validUntil: validUntil ? new Date(validUntil) : null,
      usageLimit: usageLimit || null,
      createdBy: req.user.userId
    });

    await coupon.save();

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Kupon başarıyla oluşturuldu",
      coupon: {
        _id: coupon._id,
        code: coupon.code,
        validUntil: coupon.validUntil,
        usageLimit: coupon.usageLimit,
        usedCount: coupon.usedCount,
        status: coupon.status,
        createdAt: coupon.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get All Coupons (Admin only)
const getAllCoupons = async (req, res, next) => {
  try {
    const { 
      status, 
      search,
      page = 1,
      limit = 20
    } = req.query;

    // Build filter object
    const filter = {};
    
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { code: { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Get coupons with pagination
    const coupons = await Coupon.find(filter)
      .populate('createdBy', 'name surname email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count for pagination
    const total = await Coupon.countDocuments(filter);

    // Get coupon statistics
    const stats = await Coupon.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          inactive: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] } },
          expired: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
          totalUsage: { $sum: '$usedCount' }
        }
      }
    ]);

    res.status(StatusCodes.OK).json({
      success: true,
      coupons,
      stats: stats[0] || {
        total: 0,
        active: 0,
        inactive: 0,
        expired: 0,
        totalUsage: 0
      },
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  } catch (error) {
    next(error);
  }
};


// Update Coupon (Admin only)
const updateCoupon = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      code,
      validUntil,
      usageLimit,
      status
    } = req.body;

    // Check if coupon exists
    const coupon = await Coupon.findById(id);
    if (!coupon) {
      throw new CustomError.NotFoundError("Kupon bulunamadı");
    }

    // Check if code is being changed and if it already exists
    if (code && code !== coupon.code) {
      // Ensure code starts with KM
      if (!code.toUpperCase().startsWith('KM')) {
        throw new CustomError.BadRequestError("Kupon kodu KM ile başlamalıdır");
      }
      
      const existingCoupon = await Coupon.findOne({ code: code.toUpperCase(), _id: { $ne: id } });
      if (existingCoupon) {
        throw new CustomError.BadRequestError("Bu kupon kodu zaten kullanılıyor");
      }
    }

    // Update coupon fields
    if (code) coupon.code = code.toUpperCase();
    if (validUntil !== undefined) coupon.validUntil = validUntil ? new Date(validUntil) : null;
    if (usageLimit !== undefined) coupon.usageLimit = usageLimit;
    if (status) coupon.status = status;

    await coupon.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Kupon başarıyla güncellendi",
      coupon: {
        _id: coupon._id,
        code: coupon.code,
        validUntil: coupon.validUntil,
        usageLimit: coupon.usageLimit,
        usedCount: coupon.usedCount,
        status: coupon.status,
        updatedAt: coupon.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// Delete Coupon (Admin only)
const deleteCoupon = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Check if coupon exists
    const coupon = await Coupon.findById(id);
    if (!coupon) {
      throw new CustomError.NotFoundError("Kupon bulunamadı");
    }

    // Delete the coupon
    await Coupon.findByIdAndDelete(id);

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Kupon başarıyla silindi"
    });
  } catch (error) {
    next(error);
  }
};


module.exports = {
  createCoupon,
  getAllCoupons,
  updateCoupon,
  deleteCoupon
};
