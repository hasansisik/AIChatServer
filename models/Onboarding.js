const mongoose = require('mongoose');

const onboardingSchema = new mongoose.Schema({
  mediaItems: [{
    mediaUrl: {
      type: String,
      required: true,
      trim: true
    },
    mediaType: {
      type: String,
      enum: ['image', 'video'],
      required: true
    },
    order: {
      type: Number,
      required: true,
      default: 0
    }
  }],
  status: {
    type: String,
    enum: ['active', 'inactive'],
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
onboardingSchema.index({ status: 1 });
onboardingSchema.index({ createdBy: 1 });

module.exports = mongoose.model('Onboarding', onboardingSchema);

