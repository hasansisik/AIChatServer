const { Translate } = require('@google-cloud/translate').v2;
const Settings = require('../models/Settings');

/**
 * Metni çevirir
 * POST /v1/translate
 * Body: { text: string, target: string, source?: string }
 */
const translateText = async (req, res) => {
  try {
    const { text, target = 'tr', source } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'Text is required',
      });
    }

    console.log(`🌍 Çeviri talebi: "${text.substring(0, 50)}..." -> ${target}`);

    // Settings'den Google credentials'ı çek
    const settings = await Settings.getSettings();
    
    if (!settings.googleCredentialsJson) {
      console.error('❌ Google credentials bulunamadı');
      return res.status(500).json({
        success: false,
        message: 'Google credentials not configured',
      });
    }

    // JSON string'i parse et
    let credentials;
    try {
      credentials = JSON.parse(settings.googleCredentialsJson);
    } catch (parseError) {
      console.error('❌ Google credentials parse hatası:', parseError);
      return res.status(500).json({
        success: false,
        message: 'Invalid Google credentials format',
      });
    }

    // Google Translate client'ı oluştur
    const translate = new Translate({
      credentials: credentials,
      projectId: credentials.project_id,
    });

    // Çeviri yap
    const options = {
      to: target,
    };
    
    if (source) {
      options.from = source;
    }

    const [translation, metadata] = await translate.translate(text, options);
    
    console.log(`✅ Çeviri başarılı: "${translation.substring(0, 50)}..."`);
    
    return res.status(200).json({
      success: true,
      translatedText: translation,
      detectedSourceLanguage: metadata?.detectedSourceLanguage || source,
    });
  } catch (error) {
    console.error('❌ Çeviri hatası:', error);
    return res.status(500).json({
      success: false,
      message: 'Translation failed',
      error: error.message,
    });
  }
};

module.exports = {
  translateText,
};

