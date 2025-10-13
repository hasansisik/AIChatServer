const express = require('express');
const {register,googleRegister,googleAuth,login,googleLogin,getMyProfile,getAllUsers,logout,forgotPassword,resetPassword,verifyEmail,againEmail,editProfile,deleteAccount,deleteUser,updateUserRole,updateUserStatus} = require('../controllers/auth');
const {isAuthenticated, isAdmin} = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/register',register);
router.post('/google-register',googleRegister);
router.post('/google-auth',googleAuth);
router.post('/login',login);
router.post('/google-login',googleLogin);
router.get("/me", isAuthenticated, getMyProfile);
router.get('/logout',isAuthenticated,logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/verify-email', verifyEmail);
router.post('/again-email', againEmail);
router.post('/edit-profile',isAuthenticated, editProfile);
router.delete('/delete-account',isAuthenticated, deleteAccount);

// Admin only routes
router.get('/users', isAuthenticated, isAdmin, getAllUsers);
router.delete('/users/:id', isAuthenticated, isAdmin, deleteUser);
router.patch('/users/:id/role', isAuthenticated, isAdmin, updateUserRole);
router.patch('/users/:id/status', isAuthenticated, isAdmin, updateUserStatus);

module.exports = router;
