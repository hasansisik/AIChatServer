const express = require('express');
const {
  createOnboarding,
  getAllOnboardings,
  getActiveOnboardings,
  markOnboardingAsViewed,
  updateOnboarding,
  deleteOnboarding
} = require('../controllers/onboarding');
const { isAuthenticated, isAdmin, isOptionalAuthenticated } = require('../middleware/authMiddleware');

const router = express.Router();

// Public route - Get active onboardings (for app, user-specific if authenticated)
router.get('/active', isOptionalAuthenticated, getActiveOnboardings);

// Authenticated user route - Mark onboarding as viewed
router.post('/mark-viewed', isAuthenticated, markOnboardingAsViewed);

// Admin only routes
router.post('/', isAuthenticated, isAdmin, createOnboarding);
router.get('/', isAuthenticated, isAdmin, getAllOnboardings);
router.patch('/:id', isAuthenticated, isAdmin, updateOnboarding);
router.delete('/:id', isAuthenticated, isAdmin, deleteOnboarding);

module.exports = router;

