const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  validUntil: {
    type: Date,
    default: null // null means infinite validity
  },
  usageLimit: {
    type: Number,
    default: null // null means unlimited usage
  },
  usedCount: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'expired'],
    default: 'active'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index for better query performance
couponSchema.index({ code: 1 });
couponSchema.index({ status: 1 });
couponSchema.index({ createdBy: 1 });
couponSchema.index({ validUntil: 1 });

// Virtual for checking if coupon is expired
couponSchema.virtual('isExpired').get(function() {
  if (!this.validUntil) return false;
  return new Date() > this.validUntil;
});

// Virtual for checking if usage limit is reached
couponSchema.virtual('isUsageLimitReached').get(function() {
  if (!this.usageLimit) return false;
  return this.usedCount >= this.usageLimit;
});

// Method to check if coupon is valid
couponSchema.methods.isValid = function() {
  if (this.status !== 'active') return false;
  if (this.isExpired) return false;
  if (this.isUsageLimitReached) return false;
  return true;
};

// Method to increment usage count
couponSchema.methods.incrementUsage = function() {
  this.usedCount += 1;
  return this.save();
};

// Pre-save middleware to update status based on validity
couponSchema.pre('save', function(next) {
  if (this.isExpired && this.status === 'active') {
    this.status = 'expired';
  }
  next();
});

module.exports = mongoose.model('Coupon', couponSchema);
