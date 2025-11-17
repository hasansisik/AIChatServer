const { SpeechClient } = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');

class AIService {
  constructor() {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    this.speechClient = this.initializeSpeechClient();
  }

  initializeSpeechClient() {
    try {
      const speechOptions = {};
      const inlineCredential = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

      if (inlineCredential) {
        speechOptions.credentials = JSON.parse(inlineCredential);
      } else {
        const explicitPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_STT_CREDENTIALS_PATH;
        const localServicePath = path.resolve(__dirname, '..', 'service.json');
        const siblingAppPath = path.resolve(__dirname, '..', '..', 'AIChatApp', 'service.json');

        const candidatePaths = [explicitPath, localServicePath, siblingAppPath].filter(Boolean);
        const existingPath = candidatePaths.find((candidatePath) => fs.existsSync(candidatePath));

        if (existingPath) {
          speechOptions.keyFilename = existingPath;
          console.log(`🔐 Google STT credentials: ${existingPath}`);
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

  async convertAudioToLinear16(audioBuffer) {
    const tempDir = path.join(__dirname, '..', 'temp', 'stt');
    const inputPath = path.join(tempDir, `input_${Date.now()}.m4a`);
    const outputPath = path.join(tempDir, `output_${Date.now()}.raw`);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    fs.writeFileSync(inputPath, audioBuffer);

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-f s16le',
          '-acodec pcm_s16le',
          '-ac 1',
          '-ar 16000'
        ])
        .on('end', () => {
          try {
            const convertedBuffer = fs.readFileSync(outputPath);
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
            resolve({ buffer: convertedBuffer, sampleRate: 16000 });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError.message);
          }
          reject(error);
        })
        .save(outputPath);
    });
  }

  // Speech to Text - Google Speech-to-Text
  async speechToText(audioBuffer) {
    const startTime = Date.now();

    if (!this.speechClient) {
      return {
        success: false,
        error: 'Google STT istemcisi hazır değil'
      };
    }

    try {
      const { buffer: convertedBuffer, sampleRate } = await this.convertAudioToLinear16(audioBuffer);
      const audioContent = convertedBuffer.toString('base64');
      const config = {
        languageCode: process.env.GOOGLE_STT_LANGUAGE || 'tr-TR',
        alternativeLanguageCodes: (process.env.GOOGLE_STT_ALT_LANGUAGES || 'en-US')
          .split(',')
          .map((code) => code.trim())
          .filter(Boolean),
        enableAutomaticPunctuation: true,
        model: process.env.GOOGLE_STT_MODEL || 'latest_long',
        encoding: 'LINEAR16',
        sampleRateHertz: sampleRate,
        audioChannelCount: 1
      };

      const [response] = await this.speechClient.recognize({
        audio: { content: audioContent },
        config
      });

      const text = (response.results || [])
        .map((result) => result.alternatives?.[0]?.transcript || '')
        .join(' ')
        .trim();

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`Google STT süresi: ${duration}s`);

      if (!text) {
        return {
          success: false,
          error: 'Google STT boş sonuç döndürdü'
        };
      }

      return {
        success: true,
        text
      };
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error(`Google STT Error (${duration}s):`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async transcribe(audioBuffer) {
    const sttResult = await this.speechToText(audioBuffer);
    if (!sttResult.success) {
      return sttResult;
    }

    const trimmedText = sttResult.text.trim();
    if (!trimmedText) {
      return {
        success: false,
        error: 'Ses algılanamadı veya çok kısa'
      };
    }

    return {
      success: true,
      transcription: trimmedText
    };
  }

  createStreamingSession(onResult) {
    if (!this.speechClient) {
      return null;
    }

    const request = {
      config: {
        languageCode: process.env.GOOGLE_STT_LANGUAGE || 'tr-TR',
        alternativeLanguageCodes: (process.env.GOOGLE_STT_ALT_LANGUAGES || 'en-US')
          .split(',')
          .map((code) => code.trim())
          .filter(Boolean),
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
}

module.exports = new AIService();
