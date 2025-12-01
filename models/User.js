const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const AddressSchema = new mongoose.Schema({
  street: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  postalCode: { type: String, trim: true },
  country: { type: String, trim: true, default: "Turkey" },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

const Address = mongoose.model("Address", AddressSchema);

const AuthSchema = new mongoose.Schema({
  password: { type: String, required: true, select: false },
  verificationCode: { type: Number},
  passwordToken: { type: String, select: false },
  passwordTokenExpirationDate: { type: Date, select: false },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

// Şifreyi hashleme işlemi
AuthSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Şifre karşılaştırma metodu
AuthSchema.methods.comparePassword = async function (candidatePassword) {
  const isMatch = await bcrypt.compare(candidatePassword, this.password);
  return isMatch;
};

const Auth = mongoose.model("Auth", AuthSchema);

const ProfileSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    validate: {
      validator: function (v) {
        return /^(\+90|0)?5\d{9}$/.test(v);
      },
      message: (props) => `${props.value} is not a valid phone number!`,
    },
  },
  picture: {
    type: String,
    default: "https://res.cloudinary.com/da2qwsrbv/image/upload/v1760394529/tuaai_xgpwsd.png",
  },
  bio: {
    type: String,
    maxlength: [500, 'Biyografi 500 karakterden uzun olamaz']
  },
  skills: [{
    type: String,
    trim: true
  }],
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

const Profile = mongoose.model("Profile", ProfileSchema);

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    surname: { type: String, required: true, trim: true},
    username: { type: String, sparse: true},
    email: {
      type: String,
      required: [true, "Lütfen e-posta adresinizi girin"],
      unique: true,
      lowercase: true,
    },
    birthDate: { type: Date },
    age: { 
      type: Number,
      min: [13, 'Yaş 13\'ten az olamaz'],
      max: [120, 'Yaş 120\'den fazla olamaz']
    },
    gender: { 
      type: String, 
      enum: ['male', 'female', 'other'],
      lowercase: true 
    },
    weight: { 
      type: Number,
      min: [20, 'Kilo 20 kg\'dan az olamaz'],
      max: [300, 'Kilo 300 kg\'dan fazla olamaz']
    },
    height: { 
      type: Number,
      min: [100, 'Boy 100 cm\'den az olamaz'],
      max: [250, 'Boy 250 cm\'den fazla olamaz']
    },
    role: { type: String, enum: ["admin", "user"], default: "user" },
    isVerified: { type: Boolean, default: false },
    address: { type: mongoose.Schema.Types.ObjectId, ref: 'Address' },
    auth: { type: mongoose.Schema.Types.ObjectId, ref: 'Auth' }, 
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile' },
    conversations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }],
    expoPushToken: { type: String },
    courseTrial: { type: String },
    courseCode: { 
      type: String, 
      trim: true,
      uppercase: true,
      default: null
    },
    // Active coupon code (for purchase activation)
    activeCouponCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: null
    },
    // Demo expiration date (for demo coupons) - DEPRECATED, use demoTotalMinutes instead
    demoExpiresAt: {
      type: Date,
      default: null
    },
    // Demo total minutes (for demo coupons) - total available minutes
    demoTotalMinutes: {
      type: Number,
      default: null
    },
    // Demo minutes used - only increments when user is in AIDetailVideoView
    demoMinutesUsed: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'inactive'],
        message: '{VALUE} geçerli bir durum değil'
      },
      default: 'inactive'
    },
    theme: {
      type: String,
      enum: {
        values: ['light', 'dark'],
        message: '{VALUE} geçerli bir tema değil'
      },
      default: 'light'
    },
    // Test sistemi için yeni alanlar
    votedTests: [{
      test: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Test' 
      },
      votedAt: { 
        type: Date, 
        default: Date.now 
      },
      selectedOption: { 
        type: mongoose.Schema.Types.ObjectId 
      }
    }],
    createdTests: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'Test' 
    }],
    // Kullanıcı istatistikleri
    testStats: {
      totalVotes: { type: Number, default: 0 },
      totalCreatedTests: { type: Number, default: 0 },
      favoriteCategory: { type: String }
    },
    // Kupon sistemi - sadece kullanılan kuponları takip et
    usedCoupons: [{
      coupon: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Coupon' 
      },
      usedAt: { 
        type: Date, 
        default: Date.now 
      }
    }],
    // Onboarding data
    onboardingData: {
      interest: { 
        type: String, 
        enum: ['dil-ogrenmek', 'sohbet'],
        default: null 
      },
      mainGoal: { 
        type: String, 
        enum: ['konusma', 'yazma', 'dinleme', 'okuma', 'gramer', 'kelime'],
        default: null 
      },
      reason: { 
        type: String, 
        enum: ['is', 'seyahat', 'okul', 'aile', 'arkadas', 'hobi'],
        default: null 
      },
      favorites: [{
        type: String,
        enum: ['muzik', 'film', 'kitap', 'spor', 'sanat', 'teknoloji', 'yemek', 'seyahat', 'oyun', 'dogal', 'moda', 'bilim']
      }],
      completedAt: { 
        type: Date, 
        default: null 
      }
    },
    // Onboarding completion status
    isOnboardingCompleted: { 
      type: Boolean, 
      default: false 
    },
    // Favori AI'lar
    favoriteAIs: [{
      type: String, // AI id'leri
      trim: true
    }],
    // Görülen onboarding'ler (onboarding ID'leri)
    viewedOnboardings: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Onboarding'
    }]
  },
  { timestamps: true }
);

// Pre-delete middleware for findOneAndDelete
UserSchema.pre('findOneAndDelete', async function(next) {
  next();
});

// Pre-delete middleware for findByIdAndDelete
UserSchema.pre('deleteOne', async function(next) {
  next();
});

// Method - Test oylama
UserSchema.methods.voteOnTest = function(testId, optionId) {
  // Kullanıcının bu teste daha önce oy verip vermediğini kontrol et
  const existingVoteIndex = this.votedTests.findIndex(vote => 
    vote.test.toString() === testId.toString()
  );
  
  if (existingVoteIndex !== -1) {
    // Eğer daha önce oy vermişse, tercihini güncelle
    this.votedTests[existingVoteIndex].selectedOption = optionId;
    this.votedTests[existingVoteIndex].votedAt = new Date();
  } else {
    // İlk kez oy veriyorsa, yeni oy ekle
    this.votedTests.push({
      test: testId,
      selectedOption: optionId,
      votedAt: new Date()
    });
    this.testStats.totalVotes += 1;
  }
  
  return this.save();
};

// Method - Test oluşturma
UserSchema.methods.createTest = function(testId) {
  this.createdTests.push(testId);
  this.testStats.totalCreatedTests += 1;
  return this.save();
};

// Method - En çok oy verilen kategoriyi güncelle
UserSchema.methods.updateFavoriteCategory = function(category) {
  this.testStats.favoriteCategory = category;
  return this.save();
};

const User = mongoose.model("User", UserSchema);

module.exports = { User, Address, Auth, Profile };
