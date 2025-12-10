const { User, Auth, Profile, Address } = require("../models/User");
const Token = require("../models/Token");
const { StatusCodes } = require("http-status-codes");
const CustomError = require("../errors");
const { sendResetPasswordEmail, sendVerificationEmail } = require("../helpers");
const { generateToken } = require("../services/token.service");
const bcrypt = require("bcrypt");

//Register
const register = async (req, res, next) => {
  try {
    const {
      name,
      surname,
      email,
      password,
      courseTrial,
      picture,
      expoPushToken,
    } = req.body;

    // Validate required fields
    if (!name || !surname || !email || !password) {
      throw new CustomError.BadRequestError("Lütfen tüm gerekli alanları doldurun (isim, soyisim, e-posta, şifre).");
    }

    //check email
    const emailAlreadyExists = await User.findOne({ email });
    if (emailAlreadyExists) {
      throw new CustomError.BadRequestError("Bu e-posta adresi zaten kayıtlı.");
    }

    //token create
    const verificationCode = Math.floor(1000 + Math.random() * 9000);

    // Create Auth document
    const auth = new Auth({
      password,
      verificationCode,
    });
    await auth.save();

    // Create Profile document
    const profile = new Profile({
      picture:
        picture || "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
    });
    await profile.save();

    // Create User with references
    const user = new User({
      name,
      surname,
      email,
      username: email.split("@")[0],
      courseTrial,
      expoPushToken,
      auth: auth._id,
      profile: profile._id,
      isVerified: false,
      status: 'inactive',
    });

    await user.save();

    // Update auth and profile with user reference
    auth.user = user._id;
    profile.user = user._id;
    await Promise.all([auth.save(), profile.save()]);

    const accessToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.ACCESS_TOKEN_SECRET
    );
    const refreshToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.REFRESH_TOKEN_SECRET
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/v1/auth/refreshtoken",
      maxAge: 365 * 24 * 60 * 60 * 1000, //1 year
    });

    await sendVerificationEmail({
      name: user.name,
      email: user.email,
      verificationCode,
    });

    res.json({
      message:
        "Kullanıcı başarıyla oluşturuldu. Lütfen email adresini doğrula.",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        picture: profile.picture,
        profile: profile, // Add full profile object
        courseTrial: user.courseTrial,
        theme: user.theme,
        token: accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

//Login
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new CustomError.BadRequestError(
        "Lütfen e-posta adresinizi ve şifrenizi girin"
      );
    }

    const user = await User.findOne({ email })
      .populate({
        path: "auth",
        select: "+password",
      })
      .populate("profile");

    if (!user) {
      throw new CustomError.UnauthenticatedError(
        "Ne yazık ki böyle bir kullanıcı yok"
      );
    }

    const isPasswordCorrect = await bcrypt.compare(
      password,
      user.auth.password
    );

    if (!isPasswordCorrect) {
      throw new CustomError.UnauthenticatedError("Kayıtlı şifreniz yanlış!");
    }
    if (!user.isVerified) {
      // Generate new verification code and send email
      const verificationCode = Math.floor(1000 + Math.random() * 9000);
      user.auth.verificationCode = verificationCode;
      await user.auth.save();

      await sendVerificationEmail({
        name: user.name,
        email: user.email,
        verificationCode: user.auth.verificationCode,
      });

      return res.status(403).json({
        message: "Lütfen e-postanızı doğrulayın !",
        requiresVerification: true,
        email: user.email,
      });
    }
    if (user.status === 'inactive') {
      throw new CustomError.UnauthenticatedError("Hesabınız pasif durumda. Lütfen yönetici ile iletişime geçin.");
    }

    const accessToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.ACCESS_TOKEN_SECRET
    );
    const refreshToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.REFRESH_TOKEN_SECRET
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/v1/auth/refreshtoken",
      maxAge: 365 * 24 * 60 * 60 * 1000, //1 year
    });

    const token = new Token({
      refreshToken,
      accessToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      user: user._id,
    });

    await token.save();

    res.json({
      message: "login success.",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        role: user.role,
        picture:
          user.profile?.picture ||
          "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
        profile: user.profile, // Add full profile object
        status: user.status,
        courseTrial: user.courseTrial,
        theme: user.theme,
        token: accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

//Get My Profile
const getMyProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId)
      .populate("profile")
      .populate("address");

    if (!user) {
      return res.status(404).json({
        success: false,
      });
    }

    // Check if user is inactive and kick them out
    if (user.status === 'inactive') {
      return res.status(401).json({
        success: false,
        message: "Hesabınız pasif durumda. Lütfen yönetici ile iletişime geçin.",
        requiresLogout: true
      });
    }

    res.status(200).json({
      success: true,
      user: {
        ...user.toObject(),
        isOnboardingCompleted: user.isOnboardingCompleted
      },
    });
  } catch (error) {
    next(error);
  }
};

//Get All Users (Admin only)
const getAllUsers = async (req, res, next) => {
  try {
    const { 
      role, 
      status, 
      search,
      page = 1,
      limit = 20
    } = req.query;

    // Build filter object
    const filter = {};
    
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { surname: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Get users with pagination
    const users = await User.find(filter)
      .populate("profile")
      .populate("address")
      .select('-auth') // Don't send sensitive auth data
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count for pagination
    const total = await User.countDocuments(filter);

    // Get user statistics
    const stats = await User.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          admin: { $sum: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] } },
          moderator: { $sum: { $cond: [{ $eq: ['$role', 'moderator'] }, 1, 0] } },
          user: { $sum: { $cond: [{ $eq: ['$role', 'user'] }, 1, 0] } },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          inactive: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0] } }
        }
      }
    ]);

    res.status(StatusCodes.OK).json({
      success: true,
      users,
      stats: stats[0] || {
        total: 0,
        admin: 0,
        moderator: 0,
        user: 0,
        active: 0,
        inactive: 0
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

//Logout
const logout = async (req, res, next) => {
  try {
    await Token.findOneAndDelete({ user: req.user.userId });

    res.clearCookie("refreshtoken", { path: "/v1/auth/refreshtoken" });

    res.json({
      message: "logged out !",
    });
  } catch (error) {
    next(error);
  }
};

//Forgot Password
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new CustomError.BadRequestError("Lütfen e-posta adresinizi girin.");
  }

  const user = await User.findOne({ email }).populate("auth");

  if (user) {
    const passwordToken = Math.floor(1000 + Math.random() * 9000);

    await sendResetPasswordEmail({
      name: user.name,
      email: user.email,
      passwordToken: passwordToken,
    });

    const tenMinutes = 1000 * 60 * 10;
    const passwordTokenExpirationDate = new Date(Date.now() + tenMinutes);

    user.auth.passwordToken = passwordToken;
    user.auth.passwordTokenExpirationDate = passwordTokenExpirationDate;

    await user.auth.save();
  } else {
    throw new CustomError.BadRequestError("Kullanıcı bulunamadı.");
  }

  res.status(StatusCodes.OK).json({
    message: "Şifre sıfırlama bağlantısı için lütfen e-postanızı kontrol edin.",
  });
};

//Reset Password
const resetPassword = async (req, res) => {
  try {
    const { email, passwordToken, newPassword } = req.body;
    if (!passwordToken || !newPassword) {
      throw new CustomError.BadRequestError(
        "Lütfen sıfırlama kodunu ve yeni şifrenizi girin."
      );
    }

    const user = await User.findOne({ email }).populate({
      path: "auth",
      select: "+passwordToken +passwordTokenExpirationDate",
    });

    if (user) {
      const currentDate = new Date();

      // Convert passwordToken to string for comparison
      if (user.auth.passwordToken === String(passwordToken)) {
        if (currentDate > user.auth.passwordTokenExpirationDate) {
          throw new CustomError.BadRequestError(
            "Kodunuz süresi doldu. Lütfen tekrar deneyin."
          );
        }
        user.auth.password = newPassword;
        user.auth.passwordToken = null;
        user.auth.passwordTokenExpirationDate = null;
        await user.auth.save();
        res.json({
          message: "Şifre başarıyla sıfırlandı.",
        });
      } else {
        res.status(400).json({
          message: "Geçersiz sıfırlama kodu.",
        });
      }
    } else {
      res.status(404).json({
        message: "Kullanıcı bulunamadı.",
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Sistem hatası oluştu. Lütfen tekrar deneyin.",
    });
  }
};

//Edit Profile
const editProfile = async (req, res) => {
  try {
    const updates = Object.keys(req.body);
    const allowedUpdates = [
      "name",
      "surname",
      "email",
      "password",
      "currentPassword",
      "address",
      "phoneNumber",
      "courseTrial",
      "courseCode",
      "picture",
      "birthDate",
      "age",
      "gender",
      "weight",
      "height",
      "bio",
      "skills",
      "theme",
    ];
    const isValidOperation = updates.every((update) =>
      allowedUpdates.includes(update)
    );

    if (!isValidOperation) {
      return res
        .status(400)
        .send({ error: "Sistem hatası oluştu. Lütfen tekrar deneyin" });
    }

    const user = await User.findById(req.user.userId)
      .populate({
        path: "auth",
        select: "+password"
      })
      .populate("profile")
      .populate("address");

    if (!user) {
      return res.status(404).json({
        message: "Kullanıcı bulunamadı.",
      });
    }

    if (req.body.email && req.body.email !== user.email) {
      const verificationCode = Math.floor(1000 + Math.random() * 9000);
      user.email = req.body.email;
      user.auth.verificationCode = verificationCode;
      user.isVerified = false;

      // Save auth document to persist verification code
      await user.auth.save();

      await sendVerificationEmail({
        name: user.name,
        email: user.email,
        verificationCode: verificationCode,
      });
    }

    // Handle basic fields
    if (req.body.name) user.name = req.body.name;
    if (req.body.surname) user.surname = req.body.surname;
    if (req.body.courseTrial) user.courseTrial = req.body.courseTrial;
    if (req.body.courseCode !== undefined) user.courseCode = req.body.courseCode ? req.body.courseCode.toUpperCase().trim() : null;
    if (req.body.theme) user.theme = req.body.theme;

    // Handle new profile fields
    if (req.body.birthDate) user.birthDate = new Date(req.body.birthDate);
    if (req.body.age) user.age = req.body.age;
    if (req.body.gender) user.gender = req.body.gender;
    if (req.body.weight) user.weight = req.body.weight;
    if (req.body.height) user.height = req.body.height;

    // Handle password
    if (req.body.password) {
      // Check if current password is provided and correct
      if (req.body.currentPassword) {
        const isCurrentPasswordCorrect = await bcrypt.compare(
          req.body.currentPassword,
          user.auth.password
        );
        
        if (!isCurrentPasswordCorrect) {
          return res.status(400).json({
            message: "Mevcut şifre yanlış."
          });
        }
      } else {
        return res.status(400).json({
          message: "Mevcut şifre gereklidir."
        });
      }
      
      // Update password
      user.auth.password = req.body.password;
      await user.auth.save();
    }

    // Handle phone number
    if (req.body.phoneNumber) {
      if (!user.profile) {
        const profile = new Profile({
          phoneNumber: req.body.phoneNumber,
          user: user._id,
        });
        await profile.save();
        user.profile = profile._id;
      } else {
        user.profile.phoneNumber = req.body.phoneNumber;
        await user.profile.save();
      }
    }

    // Handle profile picture
    if (req.body.picture) {
      if (!user.profile) {
        const profile = new Profile({
          picture: req.body.picture,
          user: user._id,
        });
        await profile.save();
        user.profile = profile._id;
      } else {
        user.profile.picture = req.body.picture;
        await user.profile.save();
      }
    }

    // Handle bio
    if (req.body.bio !== undefined) {
      if (!user.profile) {
        const profile = new Profile({
          bio: req.body.bio,
          user: user._id,
        });
        await profile.save();
        user.profile = profile._id;
      } else {
        user.profile.bio = req.body.bio;
        await user.profile.save();
      }
    }

    // Handle skills
    if (req.body.skills !== undefined) {
      if (!user.profile) {
        const profile = new Profile({
          skills: req.body.skills,
          user: user._id,
        });
        await profile.save();
        user.profile = profile._id;
      } else {
        user.profile.skills = req.body.skills;
        await user.profile.save();
      }
    }

    // Handle address
    if (req.body.address) {
      // Check if address is an object with the expected fields
      const addressData = req.body.address;

      if (!user.address) {
        // Create new address
        const address = new Address({
          street: addressData.street || "",
          city: addressData.city || "", // This is actually the district (ilçe)
          state: addressData.state || "", // This is actually the province (il)
          postalCode: addressData.postalCode || "",
          country: addressData.country || "Turkey",
          user: user._id,
        });
        await address.save();
        user.address = address._id;
      } else {
        // Update existing address
        if (addressData.street !== undefined)
          user.address.street = addressData.street;
        if (addressData.city !== undefined)
          user.address.city = addressData.city; // District (ilçe)
        if (addressData.state !== undefined)
          user.address.state = addressData.state; // Province (il)
        if (addressData.postalCode !== undefined)
          user.address.postalCode = addressData.postalCode;
        if (addressData.country !== undefined)
          user.address.country = addressData.country;
        await user.address.save();
      }
    }

    await user.save();

    // Populate the updated user data
    const updatedUser = await User.findById(user._id)
      .populate("profile")
      .populate("address");

    res.json({
      message: "Profil başarıyla güncellendi.",
      user: updatedUser
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Sistem hatası oluştu. Lütfen tekrar deneyin",
    });
  }
};


//Email
const verifyEmail = async (req, res) => {
  try {
    const { email, verificationCode } = req.body;

    // Validate input
    if (!email || !verificationCode) {
      return res.status(400).json({ message: "E-posta ve doğrulama kodu gereklidir." });
    }

    const user = await User.findOne({ email })
      .populate("auth")
      .populate("profile");

    if (!user) {
      return res.status(400).json({ message: "Kullanıcı bulunamadı." });
    }

    if (!user.auth) {
      return res.status(400).json({ message: "Kullanıcı kimlik doğrulama bilgisi bulunamadı." });
    }

    // Convert both to numbers for comparison
    const codeFromDB = Number(user.auth.verificationCode);
    const codeFromRequest = Number(verificationCode);

    // Check if conversion was successful
    if (isNaN(codeFromRequest)) {
      return res.status(400).json({ message: "Geçersiz doğrulama kodu formatı." });
    }

    if (isNaN(codeFromDB) || codeFromDB !== codeFromRequest) {
      return res.status(400).json({ message: "Doğrulama kodu yanlış." });
    }

    user.isVerified = true;
    user.status = 'active';
    user.auth.verificationCode = undefined;
    await user.save();
    await user.auth.save();

    // Generate tokens like login
    const accessToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.ACCESS_TOKEN_SECRET
    );
    const refreshToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.REFRESH_TOKEN_SECRET
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/v1/auth/refreshtoken",
      maxAge: 365 * 24 * 60 * 60 * 1000, //1 year
    });

    const token = new Token({
      refreshToken,
      accessToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      user: user._id,
    });

    await token.save();

    res.json({
      message: "Hesap başarıyla doğrulandı.",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        picture:
          user.profile?.picture ||
          "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
        profile: user.profile,
        status: user.status,
        courseTrial: user.courseTrial,
        theme: user.theme,
        isVerified: user.isVerified,
        token: accessToken,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Sunucu hatası." });
  }
};

//Again Email
const againEmail = async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email }).populate("auth");

  if (!user) {
    throw new Error("Kullanıcı bulunamadı.");
  }

  // If user already has a verification code, reuse it instead of creating a new one
  // This ensures consistency when user resends email after edit-profile
  let verificationCode = user.auth.verificationCode;
  
  if (!verificationCode) {
    // Only create new code if one doesn't exist
    verificationCode = Math.floor(1000 + Math.random() * 9000);
    user.auth.verificationCode = verificationCode;
    await user.auth.save();
  }

  await sendVerificationEmail({
    name: user.name,
    email: user.email,
    verificationCode: verificationCode,
  });
  res.json({ message: "Doğrulama kodu Gönderildi" });
};

//Delete Account
const deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        message: "Kullanıcı bulunamadı.",
      });
    }
    
    // Delete profile
    if (user.profile) {
      await Profile.findByIdAndDelete(user.profile);
    }
    // Delete auth
    if (user.auth) {
      await Auth.findByIdAndDelete(user.auth);
    }
    // Delete address
    if (user.address) {
      await Address.findByIdAndDelete(user.address);
    }
    // Delete tokens
    await Token.deleteMany({ user: userId });
    // Delete the user
    await User.findByIdAndDelete(userId);
    
    res.status(200).json({
      message: "Hesabınız başarıyla silindi.",
    });
  } catch (error) {
    next(error);
  }
};

//Google Auth (Unified Login/Register)
const googleAuth = async (req, res, next) => {
  try {
    const { email, name, surname, picture, googleId } = req.body;

    if (!email || !name || !googleId) {
      throw new CustomError.BadRequestError("Google bilgileri eksik");
    }

    let user = await User.findOne({ email })
      .populate("profile")
      .populate("auth");

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      
      const auth = new Auth({
        password: "google_oauth_user", // Dummy password for Google users
        verificationCode: undefined, // Google users don't need email verification
      });
      await auth.save();

      // Create Profile document
      const profile = new Profile({
        picture: "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
      });
      await profile.save();

      // Create User with references
      user = new User({
        name,
        surname: surname || 'User',
        email,
        username: email.split("@")[0],
        expoPushToken: null,
        auth: auth._id,
        profile: profile._id,
        isVerified: true, // Google users are automatically verified
        status: 'active', // Google users are automatically active
      });

      await user.save();

      // Update auth and profile with user reference
      auth.user = user._id;
      profile.user = user._id;
      await Promise.all([auth.save(), profile.save()]);
    } else {
      // Check if existing user is inactive
      if (user.status === 'inactive') {
        throw new CustomError.UnauthenticatedError("Hesabınız pasif durumda. Lütfen yönetici ile iletişime geçin.");
      }
      
      // Update existing user if needed
      if (!user.isVerified) {
        user.isVerified = true;
        user.status = 'active';
        await user.save();
      }
    }

    // Generate tokens
    const accessToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.ACCESS_TOKEN_SECRET
    );
    const refreshToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.REFRESH_TOKEN_SECRET
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/v1/auth/refreshtoken",
      maxAge: 365 * 24 * 60 * 60 * 1000, //1 year
    });

    const token = new Token({
      refreshToken,
      accessToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      user: user._id,
    });

    await token.save();

    res.json({
      message: isNewUser ? "Google ile kayıt başarılı." : "Google ile giriş başarılı.",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        picture: user.profile?.picture || picture || "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
        profile: user.profile, // Add full profile object
        status: user.status,
        courseTrial: user.courseTrial,
        theme: user.theme,
        token: accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

//Google Login
const googleLogin = async (req, res, next) => {
  try {
    const { email, name, surname, picture, googleId } = req.body;

    if (!email || !name || !surname || !googleId) {
      throw new CustomError.BadRequestError("Google bilgileri eksik");
    }

    // Check if user exists
    let user = await User.findOne({ email })
      .populate("profile")
      .populate("auth");

    if (!user) {
      throw new CustomError.UnauthenticatedError("Kullanıcı bulunamadı. Lütfen önce kayıt olun.");
    }

    // Check if user is inactive
    if (user.status === 'inactive') {
      throw new CustomError.UnauthenticatedError("Hesabınız pasif durumda. Lütfen yönetici ile iletişime geçin.");
    }

    // Check if user is verified (Google users are automatically verified)
    if (!user.isVerified) {
      user.isVerified = true;
      user.status = 'active';
      await user.save();
    }

    // Generate tokens
    const accessToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.ACCESS_TOKEN_SECRET
    );
    const refreshToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.REFRESH_TOKEN_SECRET
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/v1/auth/refreshtoken",
      maxAge: 365 * 24 * 60 * 60 * 1000, //1 year
    });

    const token = new Token({
      refreshToken,
      accessToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      user: user._id,
    });

    await token.save();

    res.json({
      message: "Google ile giriş başarılı.",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        picture: user.profile?.picture || picture || "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
        profile: user.profile, // Add full profile object
        status: user.status,
        courseTrial: user.courseTrial,
        theme: user.theme,
        token: accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

//Google Register
const googleRegister = async (req, res, next) => {
  try {
    const { email, name, surname, picture, googleId } = req.body;

    if (!email || !name || !surname || !googleId) {
      throw new CustomError.BadRequestError("Google bilgileri eksik");
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      // Check if existing user is inactive
      if (existingUser.status === 'inactive') {
        throw new CustomError.UnauthenticatedError("Hesabınız pasif durumda. Lütfen yönetici ile iletişime geçin.");
      }
      throw new CustomError.BadRequestError("Bu e-posta adresi zaten kayıtlı.");
    }

    const auth = new Auth({
      password: "google_oauth_user", // Dummy password for Google users
      verificationCode: undefined, // Google users don't need email verification
    });
    await auth.save();

    // Create Profile document
    const profile = new Profile({
      picture: picture || "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
    });
    await profile.save();

    // Create User with references
    const user = new User({
      name,
      surname,
      email,
      username: email.split("@")[0],
      expoPushToken: null,
      auth: auth._id,
      profile: profile._id,
      isVerified: true, // Google users are automatically verified
      status: 'active', // Google users are automatically active
    });

    await user.save();

    // Update auth and profile with user reference
    auth.user = user._id;
    profile.user = user._id;
    await Promise.all([auth.save(), profile.save()]);

    const accessToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.ACCESS_TOKEN_SECRET
    );
    const refreshToken = await generateToken(
      { userId: user._id, role: user.role },
      "365d",
      process.env.REFRESH_TOKEN_SECRET
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      path: "/v1/auth/refreshtoken",
      maxAge: 365 * 24 * 60 * 60 * 1000, //1 year
    });

    res.json({
      message: "Google ile kayıt başarılı.",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        picture: profile.picture,
        profile: profile, // Add full profile object
        courseTrial: user.courseTrial,
        theme: user.theme,
        token: accessToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

//Delete User (Admin only)
const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Check if user exists
    const user = await User.findById(id);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    // Check if admin is trying to delete themselves
    if (id === req.user.userId) {
      throw new CustomError.BadRequestError("Kendinizi silemezsiniz");
    }

    // Check if admin is trying to delete another admin
    if (user.role === 'admin') {
      throw new CustomError.UnauthorizedError("Admin kullanıcıları silemezsiniz");
    }
    
    // Delete profile
    if (user.profile) {
      await Profile.findByIdAndDelete(user.profile);
    }
    // Delete auth
    if (user.auth) {
      await Auth.findByIdAndDelete(user.auth);
    }
    // Delete address
    if (user.address) {
      await Address.findByIdAndDelete(user.address);
    }
    // Delete tokens
    await Token.deleteMany({ user: id });
    
    // Delete the user
    await User.findByIdAndDelete(id);

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Kullanıcı başarıyla silindi"
    });
  } catch (error) {
    next(error);
  }
};

//Update User Role (Admin only)
const updateUserRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    // Validate role
    if (!role || !['admin', 'user'].includes(role)) {
      throw new CustomError.BadRequestError("Geçersiz rol. Sadece 'admin' veya 'user' rolleri kabul edilir");
    }

    // Check if user exists
    const user = await User.findById(id);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    // Check if admin is trying to change their own role
    if (id === req.user.userId) {
      throw new CustomError.BadRequestError("Kendi rolünüzü değiştiremezsiniz");
    }

    // Update user role
    user.role = role;
    await user.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Kullanıcı rolü başarıyla güncellendi",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
};

//Update User Status (Admin only)
const updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    if (!status || !['active', 'inactive'].includes(status)) {
      throw new CustomError.BadRequestError("Geçersiz durum. Sadece 'active' veya 'inactive' durumları kabul edilir");
    }

    // Check if user exists
    const user = await User.findById(id);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    // Check if admin is trying to change their own status
    if (id === req.user.userId) {
      throw new CustomError.BadRequestError("Kendi durumunuzu değiştiremezsiniz");
    }

    // Update user status
    user.status = status;
    await user.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Kullanıcı durumu başarıyla güncellendi",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        status: user.status
      }
    });
  } catch (error) {
    next(error);
  }
};

//Create Admin User (Admin only)
const createAdminUser = async (req, res, next) => {
  try {
    const {
      name,
      surname,
      email,
      password,
      role = 'user', // Default role is user, can be changed to admin
      status = 'active'
    } = req.body;

    // Validate required fields
    if (!name || !surname || !email || !password) {
      throw new CustomError.BadRequestError("Lütfen tüm gerekli alanları doldurun");
    }

    // Check if email already exists
    const emailAlreadyExists = await User.findOne({ email });
    if (emailAlreadyExists) {
      throw new CustomError.BadRequestError("Bu e-posta adresi zaten kayıtlı");
    }

    // Create Auth document
    const auth = new Auth({
      password,
      verificationCode: undefined, // Admin created users don't need verification
    });
    await auth.save();

    // Create Profile document
    const profile = new Profile({
      picture: "https://res.cloudinary.com/da2qwsrbv/image/upload/v1765201248/kamila_bqltdh.png",
    });
    await profile.save();

    // Create User with references
    const user = new User({
      name,
      surname,
      email,
      username: email.split("@")[0],
      auth: auth._id,
      profile: profile._id,
      isVerified: true, // Admin created users are automatically verified
      status: status,
      role: role,
    });

    await user.save();

    // Update auth and profile with user reference
    auth.user = user._id;
    profile.user = user._id;
    await Promise.all([auth.save(), profile.save()]);

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Kullanıcı başarıyla oluşturuldu",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        role: user.role,
        status: user.status,
        isVerified: user.isVerified,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

//Update User (Admin only)
const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, surname, email, role, status, demoExtraMinutes } = req.body;

    // Validate required fields
    if (!name || !surname || !email) {
      throw new CustomError.BadRequestError("Lütfen tüm gerekli alanları doldurun");
    }

    // Check if user exists
    const user = await User.findById(id);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    // Check if email is being changed and if it already exists
    if (email !== user.email) {
      const emailAlreadyExists = await User.findOne({ email, _id: { $ne: id } });
      if (emailAlreadyExists) {
        throw new CustomError.BadRequestError("Bu e-posta adresi zaten kayıtlı");
      }
    }

    // Update user fields
    user.name = name;
    user.surname = surname;
    user.email = email;
    user.username = email.split("@")[0];
    
    if (role) user.role = role;
    if (status) user.status = status;
    if (req.body.courseCode !== undefined) user.courseCode = req.body.courseCode ? req.body.courseCode.toUpperCase().trim() : null;

    // Handle demo extra time - update demoMinutesRemaining
    if (demoExtraMinutes && !isNaN(parseInt(demoExtraMinutes)) && parseInt(demoExtraMinutes) > 0) {
      const minutes = parseInt(demoExtraMinutes);
      
      // If user already has demo minutes, add to it; otherwise set new
      if (user.demoMinutesRemaining && user.demoMinutesRemaining > 0) {
        // Extend existing demo
        user.demoMinutesRemaining = user.demoMinutesRemaining + minutes;
      } else {
        // Start new demo
        user.demoMinutesRemaining = minutes;
      }
    }

    await user.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Kullanıcı başarıyla güncellendi",
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        role: user.role,
        status: user.status,
        isVerified: user.isVerified,
        updatedAt: user.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// Add Demo Minutes (Admin only)
const addDemoMinutes = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { minutes } = req.body;

    // Validate required fields
    if (!minutes || isNaN(parseInt(minutes)) || parseInt(minutes) <= 0) {
      throw new CustomError.BadRequestError("Lütfen geçerli bir dakika değeri girin");
    }

    // Check if user exists
    const user = await User.findById(id);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    const minutesToAdd = parseInt(minutes);

    // If user already has demo minutes, add to it; otherwise set new
    if (user.demoMinutesRemaining && user.demoMinutesRemaining > 0) {
      // Extend existing demo
      user.demoMinutesRemaining = user.demoMinutesRemaining + minutesToAdd;
    } else {
      // Start new demo
      user.demoMinutesRemaining = minutesToAdd;
    }

    await user.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: `${minutesToAdd} dakika demo süresi başarıyla eklendi`,
      user: {
        _id: user._id,
        name: user.name,
        surname: user.surname,
        email: user.email,
        role: user.role,
        status: user.status,
        courseCode: user.courseCode,
        demoMinutesRemaining: user.demoMinutesRemaining,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

//Update Onboarding Data
const updateOnboardingData = async (req, res, next) => {
  try {
    const { interest, mainGoal, reason, favorites } = req.body;
    const userId = req.user.userId;

    // Validate required fields
    if (!interest || !mainGoal || !reason || !favorites || !Array.isArray(favorites)) {
      throw new CustomError.BadRequestError("Lütfen tüm gerekli alanları doldurun");
    }

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      throw new CustomError.NotFoundError("Kullanıcı bulunamadı");
    }

    // Update onboarding data
    user.onboardingData = {
      interest,
      mainGoal,
      reason,
      favorites,
      completedAt: new Date()
    };
    user.isOnboardingCompleted = true;

    await user.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Onboarding verileri başarıyla kaydedildi",
      onboardingData: user.onboardingData
    });
  } catch (error) {
    next(error);
  }
};

// Add Favorite AI
const addFavoriteAI = async (req, res) => {
  try {
    const { aiId } = req.body;

    if (!aiId) {
      return res.status(400).json({
        message: "AI ID gereklidir.",
      });
    }

    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({
        message: "Kullanıcı bulunamadı.",
      });
    }

    // Eğer zaten favorilerde varsa, ekleme
    if (user.favoriteAIs && user.favoriteAIs.includes(aiId)) {
      return res.status(200).json({
        message: "AI zaten favorilerde.",
        favoriteAIs: user.favoriteAIs,
      });
    }

    // Favorilere ekle
    if (!user.favoriteAIs) {
      user.favoriteAIs = [];
    }
    user.favoriteAIs.push(aiId);
    await user.save();

    res.status(200).json({
      message: "AI favorilere eklendi.",
      favoriteAIs: user.favoriteAIs,
    });
  } catch (error) {
    res.status(500).json({
      message: "Favori eklenirken hata oluştu.",
      error: error.message,
    });
  }
};

// Remove Favorite AI
const removeFavoriteAI = async (req, res) => {
  try {
    const { aiId } = req.body;

    if (!aiId) {
      return res.status(400).json({
        message: "AI ID gereklidir.",
      });
    }

    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({
        message: "Kullanıcı bulunamadı.",
      });
    }

    // Favorilerden çıkar
    if (user.favoriteAIs && user.favoriteAIs.includes(aiId)) {
      user.favoriteAIs = user.favoriteAIs.filter(id => id !== aiId);
      await user.save();
    }

    res.status(200).json({
      message: "AI favorilerden çıkarıldı.",
      favoriteAIs: user.favoriteAIs,
    });
  } catch (error) {
    res.status(500).json({
      message: "Favori çıkarılırken hata oluştu.",
      error: error.message,
    });
  }
};

// Get Favorite AIs
const getFavoriteAIs = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('favoriteAIs');

    if (!user) {
      return res.status(404).json({
        message: "Kullanıcı bulunamadı.",
      });
    }

    res.status(200).json({
      favoriteAIs: user.favoriteAIs || [],
    });
  } catch (error) {
    res.status(500).json({
      message: "Favoriler alınırken hata oluştu.",
      error: error.message,
    });
  }
};

module.exports = {
  register,
  googleRegister,
  googleAuth,
  login,
  googleLogin,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  getMyProfile,
  getAllUsers,
  againEmail,
  addDemoMinutes,
  editProfile,
  deleteAccount,
  deleteUser,
  updateUserRole,
  updateUserStatus,
  createAdminUser,
  updateUser,
  updateOnboardingData,
  addFavoriteAI,
  removeFavoriteAI,
  getFavoriteAIs,
};