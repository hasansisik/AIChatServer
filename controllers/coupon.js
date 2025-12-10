const { User } = require("../models/User");
const Coupon = require("../models/Coupon");
const { StatusCodes } = require("http-status-codes");
const CustomError = require("../errors");

// Generate unique coupon code
const generateCouponCode = (isDemo = false) => {
  // Demo coupons: KMD prefix
  // Purchase coupons: KME prefix (default)
  // Legacy coupons: KMY, KMS, KMP, KM
  let prefix;
  if (isDemo) {
    prefix = 'KMD';
  } else {
    // Default to KME for purchase
    prefix = 'KME';
  }
  
  // 5 haneli random sayı oluştur
  const randomNumber = Math.floor(10000 + Math.random() * 90000); // 10000-99999 arası
  
  return `${prefix}${randomNumber}`;
};


// Create Coupon (Admin only)
const createCoupon = async (req, res, next) => {
  try {
    const {
      code,
      isDemo = false,
      duration,
      validUntil,
      usageLimit,
      userIds
    } = req.body;

    // Validate duration for demo coupons
    if (isDemo && (!duration || duration <= 0)) {
      throw new CustomError.BadRequestError("Demo kuponları için süre (dakika) gereklidir");
    }

    // Generate code if not provided
    let couponCode = code;
    if (!couponCode) {
      // Generate unique code with retry mechanism
      let attempts = 0;
      const maxAttempts = 10;
      let isUnique = false;
      
      while (!isUnique && attempts < maxAttempts) {
        couponCode = generateCouponCode(isDemo);
        // Normalize code (uppercase and trim) - model does this automatically but we need to check
        const normalizedCode = couponCode.toUpperCase().trim();
        const existingCoupon = await Coupon.findOne({ code: normalizedCode });
        if (!existingCoupon) {
          isUnique = true;
          couponCode = normalizedCode; // Use normalized version
        } else {
          attempts++;
          console.log(`⚠️ Duplicate code found: ${normalizedCode}, retrying... (attempt ${attempts}/${maxAttempts})`);
        }
      }
      
      if (!isUnique) {
        throw new CustomError.BadRequestError("Benzersiz kupon kodu oluşturulamadı. Lütfen tekrar deneyin.");
      }
    } else {
      couponCode = couponCode.toUpperCase().trim();
    }

    // Validate code prefix based on isDemo
    const validPrefixes = isDemo ? ['KMD'] : ['KME', 'KM', 'KMY', 'KMS', 'KMP'];
    const codePrefix = couponCode.substring(0, couponCode.length >= 3 ? 3 : 2);
    if (!validPrefixes.some(prefix => couponCode.startsWith(prefix))) {
      const expectedPrefix = isDemo ? 'KMD' : 'KME';
      throw new CustomError.BadRequestError(`${isDemo ? 'Demo' : 'Satın alma'} kuponu ${expectedPrefix} ile başlamalıdır`);
    }

    // Final check if code already exists (for manually entered codes or race conditions)
    // Model has uppercase: true, so we check with normalized code
    const existingCoupon = await Coupon.findOne({ code: couponCode });
    if (existingCoupon) {
      console.log(`⚠️ Final duplicate check found existing coupon: ${couponCode} (DB: ${existingCoupon.code}, ID: ${existingCoupon._id})`);
      throw new CustomError.BadRequestError("Bu kupon kodu zaten kullanılıyor. Lütfen farklı bir kod deneyin.");
    }
    
    console.log(`✅ Code ${couponCode} is unique, proceeding with creation...`);

    // Create coupon
    // Generate unique uid for legacy index compatibility
    const uid = `coupon_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    const coupon = new Coupon({
      code: couponCode,
      isDemo: isDemo,
      duration: isDemo ? duration : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      usageLimit: usageLimit || null,
      createdBy: req.user.userId,
      uid: uid // Unique identifier for legacy index
    });

    try {
      await coupon.save();
    } catch (saveError) {
      // Handle MongoDB duplicate key error (E11000 is duplicate key error code)
      if (saveError.code === 11000 || (saveError.name === 'MongoServerError' && saveError.message?.includes('duplicate'))) {
        console.error(`❌ MongoDB duplicate key error for code: ${couponCode}`, saveError.message);
        // Double check if coupon really exists
        const doubleCheck = await Coupon.findOne({ code: couponCode });
        if (doubleCheck) {
          throw new CustomError.BadRequestError("Bu kupon kodu zaten kullanılıyor. Lütfen farklı bir kod deneyin.");
        } else {
          // This shouldn't happen, but if it does, it's a race condition
          throw new CustomError.BadRequestError("Kupon oluşturulurken bir hata oluştu. Lütfen tekrar deneyin.");
        }
      }
      // Log other errors for debugging
      console.error('❌ Coupon save error:', saveError);
      throw saveError;
    }

    // If userIds provided, update users
    if (userIds && Array.isArray(userIds) && userIds.length > 0) {
      try {
        if (isDemo && duration) {
          // Demo kuponu: Kullanıcılara demoMinutesRemaining ekle
          const users = await User.find({ _id: { $in: userIds } });
          for (const user of users) {
            if (user.demoMinutesRemaining && user.demoMinutesRemaining > 0) {
              // Mevcut süreye ekle
              user.demoMinutesRemaining = user.demoMinutesRemaining + duration;
            } else {
              // Yeni demo başlat
              user.demoMinutesRemaining = duration;
            }
            await user.save();
          }
        } else {
          // Purchase kuponu: Kullanıcılara courseCode ekle
          await User.updateMany(
            { _id: { $in: userIds } },
            { $set: { courseCode: couponCode.toUpperCase() } }
          );
        }
      } catch (userUpdateError) {
        console.error("Error updating users:", userUpdateError);
        // Don't fail the coupon creation if user update fails
      }
    }

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Kupon başarıyla oluşturuldu",
      coupon: {
        _id: coupon._id,
        code: coupon.code,
        isDemo: coupon.isDemo,
        duration: coupon.duration,
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
      .populate({
        path: 'createdBy',
        select: 'name surname email',
        populate: {
          path: 'profile',
          select: 'picture'
        }
      })
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
      status,
      userIds
    } = req.body;

    // Check if coupon exists
    const coupon = await Coupon.findById(id);
    if (!coupon) {
      throw new CustomError.NotFoundError("Kupon bulunamadı");
    }

    // Get isDemo from body or use existing
    const couponIsDemo = req.body.isDemo !== undefined ? req.body.isDemo : coupon.isDemo;

    // Check if code is being changed and if it already exists
    if (code && code !== coupon.code) {
      const codeUpper = code.toUpperCase();
      // Validate code prefix based on isDemo
      const validPrefixes = couponIsDemo ? ['KMD'] : ['KME', 'KM', 'KMY', 'KMS', 'KMP'];
      if (!validPrefixes.some(prefix => codeUpper.startsWith(prefix))) {
        const expectedPrefix = couponIsDemo ? 'KMD' : 'KME';
        throw new CustomError.BadRequestError(`${couponType === 'demo' ? 'Demo' : 'Satın alma'} kuponu ${expectedPrefix} ile başlamalıdır`);
      }
      
      const existingCoupon = await Coupon.findOne({ code: code.toUpperCase(), _id: { $ne: id } });
      if (existingCoupon) {
        throw new CustomError.BadRequestError("Bu kupon kodu zaten kullanılıyor");
      }
    }

    // Update coupon fields
    const finalCode = code ? code.toUpperCase() : coupon.code;
    if (code) coupon.code = finalCode;
    if (req.body.isDemo !== undefined) coupon.isDemo = req.body.isDemo;
    if (req.body.duration !== undefined) {
      coupon.duration = coupon.isDemo ? req.body.duration : null;
    }
    if (validUntil !== undefined) coupon.validUntil = validUntil ? new Date(validUntil) : null;
    if (usageLimit !== undefined) coupon.usageLimit = usageLimit;
    if (status) coupon.status = status;

    await coupon.save();

    // If userIds provided, update users
    if (userIds && Array.isArray(userIds) && userIds.length > 0) {
      try {
        if (coupon.isDemo && coupon.duration) {
          // Demo kuponu: Kullanıcılara demoMinutesRemaining ekle
          const users = await User.find({ _id: { $in: userIds } });
          for (const user of users) {
            if (user.demoMinutesRemaining && user.demoMinutesRemaining > 0) {
              // Mevcut süreye ekle
              user.demoMinutesRemaining = user.demoMinutesRemaining + coupon.duration;
            } else {
              // Yeni demo başlat
              user.demoMinutesRemaining = coupon.duration;
            }
            await user.save();
          }
        } else {
          // Purchase kuponu: Kullanıcılara courseCode ekle
          await User.updateMany(
            { _id: { $in: userIds } },
            { $set: { courseCode: finalCode } }
          );
        }
      } catch (userUpdateError) {
        console.error("Error updating users:", userUpdateError);
        // Don't fail the coupon update if user update fails
      }
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Kupon başarıyla güncellendi",
      coupon: {
        _id: coupon._id,
        code: coupon.code,
        isDemo: coupon.isDemo,
        duration: coupon.duration,
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

    const couponCode = coupon.code;

    // Kuponu kullanan tüm kullanıcılardan kupon kodunu temizle
    try {
      const updateResult = await User.updateMany(
        {
          $or: [
            { activeCouponCode: couponCode },
            { courseCode: couponCode }
          ]
        },
        {
          $set: {
            activeCouponCode: null,
            courseCode: null
          }
        }
      );
      
      if (updateResult.modifiedCount > 0) {
        console.log(`🧹 Kupon silindi, ${updateResult.modifiedCount} kullanıcıdan kupon kodu temizlendi: ${couponCode}`);
      }
    } catch (userUpdateError) {
      console.error("❌ Kullanıcılardan kupon kodu temizlenirken hata:", userUpdateError);
      // Kupon silme işlemini devam ettir, kullanıcı güncellemesi hatası işlemi durdurmasın
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


// Validate and Apply Coupon (Public - for app)
const validateCoupon = async (req, res, next) => {
  try {
    const { code } = req.body;

    if (!code) {
      throw new CustomError.BadRequestError("Kupon kodu gereklidir");
    }

    // Check if user is authenticated
    if (!req.user || !req.user.userId) {
      throw new CustomError.UnauthenticatedError("Bu işlem için giriş yapmanız gerekmektedir");
    }

    // Find coupon
    const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });
    if (!coupon) {
      throw new CustomError.NotFoundError("Kupon bulunamadı");
    }

    // Check if coupon is valid
    if (!coupon.isValid()) {
      throw new CustomError.BadRequestError("Kupon geçersiz veya süresi dolmuş");
    }

    // Get user
    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    // Check if user already used this coupon
    const alreadyUsed = user.usedCoupons && user.usedCoupons.some(
      usedCoupon => usedCoupon.coupon.toString() === coupon._id.toString()
    );

    if (alreadyUsed) {
      throw new CustomError.BadRequestError("Bu kuponu daha önce kullandınız");
    }

    // Handle purchase coupon
    if (!coupon.isDemo) {
      // Set active coupon code
      user.activeCouponCode = coupon.code;
      user.courseCode = coupon.code; // Also set courseCode for compatibility
      
      // Add to used coupons
      if (!user.usedCoupons) {
        user.usedCoupons = [];
      }
      user.usedCoupons.push({
        coupon: coupon._id,
        usedAt: new Date()
      });

      await user.save();
      
      // Increment coupon usage
      await coupon.incrementUsage();

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Kupon başarıyla aktif edildi",
        coupon: {
          isDemo: false,
          code: coupon.code
        }
      });
    }

    // Handle demo coupon
    if (coupon.isDemo) {
      // Set demoMinutesRemaining (add to existing or set new)
      if (user.demoMinutesRemaining && user.demoMinutesRemaining > 0) {
        // Extend existing demo
        user.demoMinutesRemaining = user.demoMinutesRemaining + coupon.duration;
      } else {
        // Start new demo
        user.demoMinutesRemaining = coupon.duration;
      }

      // Demo kuponu için de courseCode set et (hem demo hem kurs kodu olarak kullanılabilir)
      user.activeCouponCode = coupon.code;
      user.courseCode = coupon.code; // Kurs kodu olarak da kaydet

      // Add to used coupons
      if (!user.usedCoupons) {
        user.usedCoupons = [];
      }
      user.usedCoupons.push({
        coupon: coupon._id,
        usedAt: new Date()
      });

      await user.save();
      
      // Increment coupon usage
      await coupon.incrementUsage();

      return res.status(StatusCodes.OK).json({
        success: true,
        message: `Demo erişim ${coupon.duration} dakika için aktif edildi`,
        coupon: {
          isDemo: true,
          code: coupon.code,
          duration: coupon.duration,
          minutesRemaining: user.demoMinutesRemaining
        }
      });
    }

    throw new CustomError.BadRequestError("Geçersiz kupon tipi");
  } catch (error) {
    next(error);
  }
};

// Check Demo Status (Authenticated users)
const checkDemoStatus = async (req, res, next) => {
  try {
    if (!req.user || !req.user.userId) {
      return res.status(StatusCodes.OK).json({
        success: true,
        hasDemo: false,
        minutesRemaining: null
      });
    }

    const user = await User.findById(req.user.userId).select('demoMinutesRemaining activeCouponCode courseCode');
    if (!user) {
      return res.status(StatusCodes.OK).json({
        success: true,
        hasDemo: false,
        minutesRemaining: null
      });
    }

    // Check if user has active demo (demoMinutesRemaining > 0)
    const hasActiveDemo = user.demoMinutesRemaining && user.demoMinutesRemaining > 0;
    
    // Check if coupon (demo or purchase) is still valid
    // Coupon sadece kendi süresi (validUntil) bittiğinde veya geçersiz olduğunda temizlenir
    // Demo süresi bitince coupon silinmez, sadece demo erişimi biter
    let hasActivePurchase = false;
    if (user.activeCouponCode || user.courseCode) {
      const couponCode = user.activeCouponCode || user.courseCode;
      // Find the coupon and check if it's still valid
      const coupon = await Coupon.findOne({ code: couponCode });
      if (coupon && coupon.isValid()) {
        // Coupon exists and is valid (active status, not expired, not over usage limit)
        // Demo kuponu olsa bile, eğer geçerliyse (validUntil kontrolü) coupon kalır
        hasActivePurchase = true;
      } else {
        // Coupon is invalid (deleted, expired, or inactive) - clear user's activeCouponCode
        // Bu durumda hem demo hem purchase kuponları temizlenir
        user.activeCouponCode = null;
        user.courseCode = null;
        await user.save();
      }
    }
    
    return res.status(StatusCodes.OK).json({
      success: true,
      hasDemo: hasActiveDemo,
      hasPurchase: hasActivePurchase,
      minutesRemaining: user.demoMinutesRemaining || 0,
      activeCouponCode: user.activeCouponCode
    });
  } catch (error) {
    next(error);
  }
};

// Update Demo Minutes (Real-time usage tracking)
const updateDemoMinutes = async (req, res, next) => {
  try {
    if (!req.user || !req.user.userId) {
      throw new CustomError.UnauthenticatedError("Bu işlem için giriş yapmanız gerekmektedir");
    }

    const { minutesRemaining } = req.body;

    if (minutesRemaining === undefined || minutesRemaining === null) {
      throw new CustomError.BadRequestError("Kalan dakika bilgisi gereklidir");
    }

    const minutes = parseFloat(minutesRemaining);
    if (isNaN(minutes) || minutes < 0) {
      throw new CustomError.BadRequestError("Geçersiz dakika değeri");
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    // Update demo minutes remaining
    const finalMinutes = Math.max(0, Math.floor(minutes)); // Ensure non-negative integer
    user.demoMinutesRemaining = finalMinutes;
    
    // Demo süresi bitince coupon'ı silme - coupon'ın kendi süresi (validUntil) var
    // Coupon sadece geçersiz olduğunda (expired, deleted, inactive) temizlenecek
    // checkDemoStatus fonksiyonunda bu kontrol yapılıyor
    
    await user.save();

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Demo süresi güncellendi",
      minutesRemaining: user.demoMinutesRemaining
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createCoupon,
  getAllCoupons,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  checkDemoStatus,
  updateDemoMinutes
};