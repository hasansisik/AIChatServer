const express = require('express');
const {
  createCoupon,
  getAllCoupons,
  updateCoupon,
  deleteCoupon
} = require('../controllers/coupon');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// Admin only routes
router.post('/', isAuthenticated, isAdmin, createCoupon);
router.get('/', isAuthenticated, isAdmin, getAllCoupons);
router.patch('/:id', isAuthenticated, isAdmin, updateCoupon);
router.delete('/:id', isAuthenticated, isAdmin, deleteCoupon);

module.exports = router;
