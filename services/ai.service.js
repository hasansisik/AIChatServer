const { SpeechClient } = require('@google-cloud/speech');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const Settings = require('../models/Settings');

class AIService {
  constructor() {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    this.settingsCache = {
      openaiApiKey: null,
      googleCredentialsJson: null,
      lastUpdated: null
    };
    this.speechClient = null;
    this.openai = null;
    this.initializeFromSettings();
    this.cleanupTempFiles();
    setInterval(() => this.cleanupTempFiles(), 5 * 60 * 1000);
    setInterval(() => this.refreshSettings(), 30 * 1000);
  }

  async initializeFromSettings() {
    try {
      const settings = await Settings.getSettings();
      this.settingsCache = {
        openaiApiKey: settings.openaiApiKey || process.env.OPENAI_API_KEY || null,
        googleCredentialsJson: settings.googleCredentialsJson || null,
        lastUpdated: settings.updatedAt || new Date()
      };
      this.speechClient = this.initializeSpeechClient();
      this.openai = this.initializeOpenAI();
    } catch (error) {
      console.error('❌ Settings yüklenemedi, env değerleri kullanılıyor:', error.message);
      this.settingsCache = {
        openaiApiKey: process.env.OPENAI_API_KEY || null,
        googleCredentialsJson: null,
        lastUpdated: null
      };
      this.speechClient = this.initializeSpeechClient();
      this.openai = this.initializeOpenAI();
    }
  }

  async refreshSettings() {
    try {
      const settings = await Settings.getSettings();
      const newUpdatedAt = settings.updatedAt ? new Date(settings.updatedAt) : new Date();
      
      if (this.settingsCache.lastUpdated) {
        const lastUpdated = new Date(this.settingsCache.lastUpdated);
        if (newUpdatedAt.getTime() <= lastUpdated.getTime()) {
          return;
        }
      }

      const openaiChanged = this.settingsCache.openaiApiKey !== settings.openaiApiKey;
      const googleChanged = this.settingsCache.googleCredentialsJson !== settings.googleCredentialsJson;

      this.settingsCache = {
        openaiApiKey: settings.openaiApiKey || process.env.OPENAI_API_KEY || null,
        googleCredentialsJson: settings.googleCredentialsJson || null,
        lastUpdated: newUpdatedAt
      };

      if (openaiChanged) {
        console.log('🔄 OpenAI API Key güncellendi, client yeniden başlatılıyor...');
        this.openai = this.initializeOpenAI();
      }

      if (googleChanged) {
        console.log('🔄 Google Credentials güncellendi, client yeniden başlatılıyor...');
        this.speechClient = this.initializeSpeechClient();
      }
    } catch (error) {
      console.error('❌ Settings yenileme hatası:', error.message);
    }
  }

  cleanupTempFiles() {
    try {
      const tempDir = path.join(__dirname, '..', 'temp', 'stt');
      if (!fs.existsSync(tempDir)) {
        return;
      }

      const files = fs.readdirSync(tempDir);
      const now = Date.now();
      let cleanedCount = 0;

      files.forEach((file) => {
        const filePath = path.join(tempDir, file);
        try {
          const stats = fs.statSync(filePath);
          const fileAge = now - stats.mtimeMs;
          if (fileAge > 5 * 60 * 1000) {
            fs.unlinkSync(filePath);
            cleanedCount++;
          }
        } catch (error) {
          try {
            fs.unlinkSync(filePath);
            cleanedCount++;
          } catch (e) {
            console.warn(`⚠️ Geçici dosya silinemedi: ${filePath}`, e.message);
          }
        }
      });

      if (cleanedCount > 0) {
        console.log(`🧹 ${cleanedCount} geçici STT dosyası temizlendi`);
      }
    } catch (error) {
      console.warn('⚠️ Geçici dosya temizleme hatası:', error.message);
    }
  }

  initializeSpeechClient() {
    try {
      const speechOptions = {};
      
      if (this.settingsCache.googleCredentialsJson) {
        try {
          const credentials = JSON.parse(this.settingsCache.googleCredentialsJson);
          speechOptions.credentials = credentials;
          console.log(`🔐 Google STT credentials: Settings'ten yüklendi`);
          return new SpeechClient(speechOptions);
        } catch (parseError) {
          console.error('❌ Settings\'teki Google credentials parse edilemedi:', parseError.message);
        }
      }

      const localServicePath = path.resolve(__dirname, '..', 'service.json');
      
      if (fs.existsSync(localServicePath)) {
        try {
          const serviceJsonContent = fs.readFileSync(localServicePath, 'utf8');
          const credentials = JSON.parse(serviceJsonContent);
          speechOptions.credentials = credentials;
          console.log(`🔐 Google STT credentials: service.json dosyasından yüklendi`);
        } catch (parseError) {
          console.error('❌ service.json parse edilemedi:', parseError.message);
          speechOptions.keyFilename = localServicePath;
          console.log(`🔐 Google STT credentials: keyFilename olarak kullanılıyor: ${localServicePath}`);
        }
      } else {
        const explicitPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_STT_CREDENTIALS_PATH;
        const siblingAppPath = path.resolve(__dirname, '..', '..', 'AIChatApp', 'service.json');

        const candidatePaths = [explicitPath, siblingAppPath].filter(Boolean);
        const existingPath = candidatePaths.find((candidatePath) => fs.existsSync(candidatePath));

        if (existingPath) {
          try {
            const serviceJsonContent = fs.readFileSync(existingPath, 'utf8');
            const credentials = JSON.parse(serviceJsonContent);
            speechOptions.credentials = credentials;
            console.log(`🔐 Google STT credentials: ${existingPath} dosyasından yüklendi`);
          } catch (parseError) {
            speechOptions.keyFilename = existingPath;
            console.log(`🔐 Google STT credentials: keyFilename olarak kullanılıyor: ${existingPath}`);
          }
        } else {
          console.warn('⚠️ Google STT credential dosyası bulunamadı. Varsayılan ADC kullanılacak.');
        }
      }

      return new SpeechClient(speechOptions);
    } catch (error) {
      console.error('❌ Google STT istemcisi oluşturulamadı:', error.message);
      return null;
    }
  }

  initializeOpenAI() {
    try {
      const apiKey = this.settingsCache.openaiApiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.warn('⚠️ OpenAI API Key tanımlı değil. LLM/TTS devre dışı.');
        return null;
      }
      console.log(`🔐 OpenAI API Key: Settings'ten yüklendi`);
      return new OpenAI({
        apiKey: apiKey
      });
    } catch (error) {
      console.error('❌ OpenAI istemcisi oluşturulamadı:', error.message);
      return null;
    }
  }

  async convertAudioToLinear16(audioBuffer) {
    const tempDir = path.join(__dirname, '..', 'temp', 'stt');
    const timestamp = Date.now();
    const inputPath = path.join(tempDir, `input_${timestamp}.m4a`);
    const outputPath = path.join(tempDir, `output_${timestamp}.raw`);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    if (!Buffer.isBuffer(audioBuffer)) {
      throw new Error('Audio buffer must be a Buffer');
    }

    if (audioBuffer.length === 0) {
      throw new Error('Audio buffer is empty');
    }

    if (audioBuffer.length < 100) {
      throw new Error('Audio buffer is too small');
    }

    const cleanupFiles = () => {
      try {
        if (fs.existsSync(inputPath)) {
          fs.unlinkSync(inputPath);
        }
      } catch (error) {
        console.warn(`⚠️ Input dosyası silinemedi: ${inputPath}`, error.message);
      }
      try {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch (error) {
        console.warn(`⚠️ Output dosyası silinemedi: ${outputPath}`, error.message);
      }
    };

    const cleanupTimeout = setTimeout(() => {
      console.warn(`⚠️ Geçici dosyalar timeout nedeniyle temizleniyor: ${inputPath}`);
      cleanupFiles();
    }, 30000);

    try {
      fs.writeFileSync(inputPath, audioBuffer);
    } catch (error) {
      clearTimeout(cleanupTimeout);
      cleanupFiles();
      throw error;
    }

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-f s16le',
          '-acodec pcm_s16le',
          '-ac 1',
          '-ar 16000'
        ])
        .on('end', () => {
          clearTimeout(cleanupTimeout);
          try {
            const convertedBuffer = fs.readFileSync(outputPath);
            cleanupFiles();
            resolve({ buffer: convertedBuffer, sampleRate: 16000 });
          } catch (error) {
            cleanupFiles();
            reject(error);
          }
        })
        .on('error', (error) => {
          clearTimeout(cleanupTimeout);
          cleanupFiles();
          reject(error);
        })
        .save(outputPath);
    });
  }

  createStreamingSession(onResult, language = 'tr') {
    if (!this.speechClient) {
      return null;
    }

    const languageCode = language === 'en' ? 'en-US' : 'tr-TR';
    const alternativeLanguageCodes = language === 'en' 
      ? ['tr-TR'] 
      : ['en-US'];

    const request = {
      config: {
        languageCode: languageCode,
        alternativeLanguageCodes: alternativeLanguageCodes,
        enableAutomaticPunctuation: true,
        model: process.env.GOOGLE_STT_MODEL || 'latest_long',
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        audioChannelCount: 1
      },
      interimResults: true
    };

    const recognizeStream = this.speechClient.streamingRecognize(request)
      .on('data', (data) => {
        try {
          const result = data.results?.[0];
          const transcript = result?.alternatives?.[0]?.transcript?.trim();
          if (transcript) {
            onResult({
              text: transcript,
              isFinal: Boolean(result?.isFinal)
            });
          }
        } catch (error) {
          console.error('Streaming STT parse error:', error);
        }
      })
      .on('error', (error) => {
        console.error('Streaming STT error:', error);
        onResult({
          error: true,
          message: error.message
        });
      });

    let isClosed = false;
    recognizeStream.on('error', () => {
      isClosed = true;
    });
    recognizeStream.on('end', () => {
      isClosed = true;
    });

    return {
      writeChunk: async (audioBuffer) => {
        if (isClosed) {
          throw new Error('STT akışı kapandı');
        }
        const { buffer } = await this.convertAudioToLinear16(audioBuffer);
        recognizeStream.write(buffer);
      },
      finish: async () => {
        if (isClosed) {
          return;
        }
        isClosed = true;
        return new Promise((resolve) => {
          recognizeStream.once('end', resolve);
          recognizeStream.once('error', resolve);
          recognizeStream.end();
        });
      },
      cancel: () => {
        isClosed = true;
        recognizeStream.destroy();
      }
    };
  }

  async generateAssistantReply(userText) {
    if (!this.openai) {
      throw new Error('OpenAI istemcisi hazır değil');
    }

    const systemPrompt = process.env.LLM_SYSTEM_PROMPT || 'You are a warm and friendly assistant. Give short and friendly answers. IMPORTANT: Always respond in English, regardless of what language the user speaks. Even if the user writes in Turkish or any other language, you must always respond in English.';

    const llmStart = Date.now();
    const completion = await this.openai.chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ],
      max_tokens: Number(process.env.LLM_MAX_TOKENS || 80),
      temperature: Number(process.env.LLM_TEMPERATURE || 0.6)
    });
    const llmDuration = Date.now() - llmStart;

    const replyText = completion.choices?.[0]?.message?.content?.trim();
    if (!replyText) {
      throw new Error('LLM boş cevap döndürdü');
    }
    console.log(`🤖 LLM süresi: ${llmDuration}ms`);
    return replyText;
  }

  async synthesizeSpeech(text, voice) {
    if (!this.openai) {
      throw new Error('OpenAI istemcisi hazır değil');
    }

    if (!voice || !voice.trim()) {
      throw new Error('Voice parametresi gerekli');
    }

    const ttsStart = Date.now();
    const response = await this.openai.audio.speech.create({
      model: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
      voice: voice.trim(),
      input: text,
      format: 'mp3',
      speed: Number(process.env.TTS_SPEED || 1.0)
    });

    const arrayBuffer = await response.arrayBuffer();
    const duration = Date.now() - ttsStart;
    console.log(`🔊 TTS süresi: ${duration}ms`);
    return Buffer.from(arrayBuffer);
  }

  async generateAssistantReplyWithTTS(userText, voice) {
    if (!voice || !voice.trim()) {
      throw new Error('Voice parametresi gerekli');
    }

    const totalStart = Date.now();
    const replyText = await this.generateAssistantReply(userText);
    const audioBuffer = await this.synthesizeSpeech(replyText, voice);
    const totalDuration = Date.now() - totalStart;
    console.log(`⚡ LLM+TTS toplam: ${totalDuration}ms`);
    return {
      replyText,
      audioBuffer
    };
  }
}

module.exports = new AIService();