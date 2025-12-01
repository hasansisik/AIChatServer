const express = require('express');
const {
  createCoupon,
  getAllCoupons,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  checkDemoStatus,
  updateDemoMinutes
} = require('../controllers/coupon');
const { isAuthenticated, isAdmin, isOptionalAuthenticated } = require('../middleware/authMiddleware');

const router = express.Router();

// Public routes (for app)
router.post('/validate', isAuthenticated, validateCoupon);
router.get('/demo-status', isOptionalAuthenticated, checkDemoStatus);
router.patch('/update-demo-minutes', isAuthenticated, updateDemoMinutes);

// Admin only routes
router.post('/', isAuthenticated, isAdmin, createCoupon);
router.get('/', isAuthenticated, isAdmin, getAllCoupons);
router.patch('/:id', isAuthenticated, isAdmin, updateCoupon);
router.delete('/:id', isAuthenticated, isAdmin, deleteCoupon);

module.exports = router;