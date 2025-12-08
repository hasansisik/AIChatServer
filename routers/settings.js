const express = require('express');
const {
  getSettings,
  updateSettings
} = require('../controllers/settings');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', isAuthenticated, isAdmin, getSettings);
router.patch('/', isAuthenticated, isAdmin, updateSettings);

module.exports = router;

