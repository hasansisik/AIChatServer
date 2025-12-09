const Settings = require("../models/Settings");
const { StatusCodes } = require("http-status-codes");
const CustomError = require("../errors");

const getSettings = async (req, res, next) => {
  try {
    const settings = await Settings.getSettings();
    
    res.status(StatusCodes.OK).json({
      success: true,
      settings: {
        openaiApiKey: settings.openaiApiKey || "",
        googleCredentialsJson: settings.googleCredentialsJson || "",
        updatedAt: settings.updatedAt,
        updatedBy: settings.updatedBy
      }
    });
  } catch (error) {
    next(error);
  }
};

const updateSettings = async (req, res, next) => {
  try {
    const { openaiApiKey, googleCredentialsJson } = req.body;
    
    if (openaiApiKey === undefined && googleCredentialsJson === undefined) {
      throw new CustomError.BadRequestError("En az bir ayar güncellenmelidir");
    }

    const userId = req.user.userId;
    const settings = await Settings.updateSettings(
      {
        openaiApiKey,
        googleCredentialsJson
      },
      userId
    );

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Ayarlar başarıyla güncellendi",
      settings: {
        openaiApiKey: settings.openaiApiKey ? "***" : "",
        googleCredentialsJson: settings.googleCredentialsJson ? "***" : "",
        updatedAt: settings.updatedAt,
        updatedBy: settings.updatedBy
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSettings,
  updateSettings
};


