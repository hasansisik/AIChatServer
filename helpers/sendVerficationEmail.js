const sendEmail = require('./sendEmail');

const sendVerificationEmail = async ({
  name,
  email,
  verificationCode,
}) => {
  const htmlTemplate = `
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>E-posta Doğrulama - Kamila</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
      <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5; padding: 20px;">
        <tr>
          <td align="center" style="padding: 20px 0;">
            <table role="presentation" style="width: 100%; max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;">
              <!-- Header -->
              <tr>
                <td style="background-color: #764ba2; padding: 40px 30px; text-align: center;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Kamila</h1>
                  <p style="margin: 10px 0 0 0; color: #ffffff; font-size: 14px; opacity: 0.9;">E-posta Doğrulama</p>
                </td>
              </tr>
              
              <!-- Content -->
              <tr>
                <td style="padding: 40px 30px;">
                  <h2 style="margin: 0 0 20px 0; color: #1a1a1a; font-size: 24px; font-weight: 600;">Merhaba ${name},</h2>
                  <p style="margin: 0 0 20px 0; color: #666666; font-size: 16px; line-height: 1.6;">
                    Kamila hesabınızı doğrulamak için aşağıdaki doğrulama kodunu kullanabilirsiniz.
                  </p>
                  
                  <!-- Verification Code Box -->
                  <table role="presentation" style="width: 100%; margin: 30px 0;">
                    <tr>
                      <td align="center" style="padding: 0;">
                        <div style="background-color: #764ba2; border-radius: 12px; padding: 30px; text-align: center; box-shadow: 0 4px 12px rgba(118, 75, 162, 0.3);">
                          <p style="margin: 0 0 10px 0; color: #ffffff; font-size: 14px; font-weight: 500; text-transform: uppercase; letter-spacing: 1px;">Doğrulama Kodu</p>
                          <p style="margin: 0; color: #ffffff; font-size: 36px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace;">${verificationCode}</p>
                        </div>
                      </td>
                    </tr>
                  </table>
                  
                  <p style="margin: 20px 0 0 0; color: #999999; font-size: 14px; line-height: 1.6;">
                    Bu kod 10 dakika süreyle geçerlidir. Eğer bu işlemi siz yapmadıysanız, bu e-postayı görmezden gelebilirsiniz.
                  </p>
                </td>
              </tr>
              
              <!-- Footer -->
              <tr>
                <td style="padding: 30px; background-color: #f9f9f9; border-top: 1px solid #eeeeee; text-align: center;">
                  <p style="margin: 0 0 10px 0; color: #999999; font-size: 12px;">
                    © ${new Date().getFullYear()} Kamila. Tüm hakları saklıdır.
                  </p>
                  <p style="margin: 0; color: #999999; font-size: 12px;">
                    Bu e-posta otomatik olarak gönderilmiştir. Lütfen yanıtlamayın.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  return sendEmail({
    to: email,
    subject: 'Kamila - E-posta Doğrulama Kodu',
    html: htmlTemplate,
  });
};

module.exports = sendVerificationEmail;
