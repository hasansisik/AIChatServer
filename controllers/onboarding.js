const Onboarding = require("../models/Onboarding");
const { StatusCodes } = require("http-status-codes");
const CustomError = require("../errors");

// Create Onboarding (Admin only)
const createOnboarding = async (req, res, next) => {
  try {
    const {
      mediaItems,
      status
    } = req.body;

    // Validate required fields
    if (!mediaItems || !Array.isArray(mediaItems) || mediaItems.length === 0) {
      throw new CustomError.BadRequestError("En az bir medya öğesi gereklidir");
    }

    // Validate each media item
    for (const item of mediaItems) {
      if (!item.mediaUrl || !item.mediaType) {
        throw new CustomError.BadRequestError("Her medya öğesi için URL ve tip gereklidir");
      }
      if (!['image', 'video'].includes(item.mediaType)) {
        throw new CustomError.BadRequestError("Medya tipi 'image' veya 'video' olmalıdır");
      }
    }

    // Sort mediaItems by order and assign order if missing
    const sortedItems = mediaItems.map((item, index) => ({
      mediaUrl: item.mediaUrl,
      mediaType: item.mediaType,
      order: item.order !== undefined ? item.order : index
    })).sort((a, b) => a.order - b.order);

    // Create onboarding
    const onboarding = new Onboarding({
      mediaItems: sortedItems,
      status: status || 'active',
      createdBy: req.user.userId
    });

    await onboarding.save();

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Onboarding başarıyla oluşturuldu",
      onboarding: {
        _id: onboarding._id,
        mediaItems: onboarding.mediaItems,
        status: onboarding.status,
        createdAt: onboarding.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get All Onboardings (Admin only)
const getAllOnboardings = async (req, res, next) => {
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
        { 'mediaItems.mediaUrl': { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Get onboardings with pagination
    const onboardings = await Onboarding.find(filter)
      .populate({
        path: 'createdBy',
        select: 'name surname email',
        populate: {
          path: 'profile',
          select: 'picture'
        }
      })
      .sort({ order: 1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count for pagination
    const total = await Onboarding.countDocuments(filter);

    res.status(StatusCodes.OK).json({
      success: true,
      onboardings,
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

// Get Active Onboardings (Public - for app)
const getActiveOnboardings = async (req, res, next) => {
  try {
    const onboardings = await Onboarding.find({ status: 'active' })
      .sort({ createdAt: -1 })
      .select('mediaItems');

    // Flatten mediaItems from all onboardings into a single array
    const allMediaItems = [];
    onboardings.forEach(onboarding => {
      if (onboarding.mediaItems && onboarding.mediaItems.length > 0) {
        onboarding.mediaItems.forEach(item => {
          allMediaItems.push({
            _id: item._id || `${onboarding._id}-${item.order}`,
            mediaUrl: item.mediaUrl,
            mediaType: item.mediaType,
            order: item.order
          });
        });
      }
    });

    // Sort by order
    allMediaItems.sort((a, b) => a.order - b.order);

    res.status(StatusCodes.OK).json({
      success: true,
      onboardings: allMediaItems
    });
  } catch (error) {
    next(error);
  }
};

// Update Onboarding (Admin only)
const updateOnboarding = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      mediaItems,
      status
    } = req.body;

    // Check if onboarding exists
    const onboarding = await Onboarding.findById(id);
    if (!onboarding) {
      throw new CustomError.NotFoundError("Onboarding bulunamadı");
    }

    // Update mediaItems if provided
    if (mediaItems && Array.isArray(mediaItems)) {
      // Validate each media item
      for (const item of mediaItems) {
        if (!item.mediaUrl || !item.mediaType) {
          throw new CustomError.BadRequestError("Her medya öğesi için URL ve tip gereklidir");
        }
        if (!['image', 'video'].includes(item.mediaType)) {
          throw new CustomError.BadRequestError("Medya tipi 'image' veya 'video' olmalıdır");
        }
      }

      // Sort mediaItems by order
      const sortedItems = mediaItems.map((item, index) => ({
        mediaUrl: item.mediaUrl,
        mediaType: item.mediaType,
        order: item.order !== undefined ? item.order : index
      })).sort((a, b) => a.order - b.order);

      onboarding.mediaItems = sortedItems;
    }

    // Update status if provided
    if (status) onboarding.status = status;

    await onboarding.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Onboarding başarıyla güncellendi",
      onboarding: {
        _id: onboarding._id,
        mediaItems: onboarding.mediaItems,
        status: onboarding.status,
        updatedAt: onboarding.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// Delete Onboarding (Admin only)
const deleteOnboarding = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Check if onboarding exists
    const onboarding = await Onboarding.findById(id);
    if (!onboarding) {
      throw new CustomError.NotFoundError("Onboarding bulunamadı");
    }

    // Delete the onboarding
    await Onboarding.findByIdAndDelete(id);

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Onboarding başarıyla silindi"
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createOnboarding,
  getAllOnboardings,
  getActiveOnboardings,
  updateOnboarding,
  deleteOnboarding
};

