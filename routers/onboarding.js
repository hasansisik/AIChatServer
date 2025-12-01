const express = require('express');
const {
  createOnboarding,
  getAllOnboardings,
  getActiveOnboardings,
  updateOnboarding,
  deleteOnboarding
} = require('../controllers/onboarding');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// Public route - Get active onboardings (for app)
router.get('/active', getActiveOnboardings);

// Admin only routes
router.post('/', isAuthenticated, isAdmin, createOnboarding);
router.get('/', isAuthenticated, isAdmin, getAllOnboardings);
router.patch('/:id', isAuthenticated, isAdmin, updateOnboarding);
router.delete('/:id', isAuthenticated, isAdmin, deleteOnboarding);

module.exports = router;

