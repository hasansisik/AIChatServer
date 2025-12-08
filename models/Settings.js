const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema(
  {
    openaiApiKey: {
      type: String,
      default: "",
      select: false
    },
    googleCredentialsJson: {
      type: String,
      default: "",
      select: false
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  },
  {
    timestamps: true
  }
);

SettingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne().select("+openaiApiKey +googleCredentialsJson");
  if (!settings) {
    const newSettings = new this({
      openaiApiKey: process.env.OPENAI_API_KEY || "",
      googleCredentialsJson: ""
    });
    await newSettings.save();
    settings = await this.findById(newSettings._id).select("+openaiApiKey +googleCredentialsJson");
  }
  return settings;
};

SettingsSchema.statics.updateSettings = async function(data, userId) {
  let settings = await this.findOne().select("+openaiApiKey +googleCredentialsJson");
  if (!settings) {
    const newSettings = new this({
      ...data,
      updatedBy: userId
    });
    await newSettings.save();
    settings = await this.findById(newSettings._id).select("+openaiApiKey +googleCredentialsJson");
    return settings;
  }
  
  if (data.openaiApiKey !== undefined) {
    settings.openaiApiKey = data.openaiApiKey;
  }
  if (data.googleCredentialsJson !== undefined) {
    settings.googleCredentialsJson = data.googleCredentialsJson;
  }
  settings.updatedBy = userId;
  await settings.save();
  return await this.findById(settings._id).select("+openaiApiKey +googleCredentialsJson");
};

const Settings = mongoose.model("Settings", SettingsSchema);
module.exports = Settings;

