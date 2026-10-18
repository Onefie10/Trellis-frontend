import React, { useState, useEffect, useRef } from 'react';
import { QRCodeConfig } from '../types';
import QRCode from 'qrcode';

interface QRCodeGeneratorProps {
  config: QRCodeConfig;
  className?: string;
}

const QRCodeGenerator: React.FC<QRCodeGeneratorProps> = ({ config, className = '' }) => {
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    generateQRCode();
  }, [config]);

  const generateQRCode = async () => {
    setIsLoading(true);
    try {
      const url = await QRCode.toDataURL(config.url, {
        width: config.size || 200,
        margin: 2,
        color: {
          dark: config.fgColor || '#000000',
          light: config.bgColor || '#ffffff',
        },
      });
      setQrCodeUrl(url);
    } catch (error) {
      console.error('Failed to generate QR code:', error);
      // Fallback to external QR code service
      const fallbackUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${config.size || 200}x${config.size || 200}&data=${encodeURIComponent(config.url)}`;
      setQrCodeUrl(fallbackUrl);
    } finally {
      setIsLoading(false);
    }
  };

  const downloadQRCode = () => {
    if (!qrCodeUrl) return;
    const link = document.createElement('a');
    link.href = qrCodeUrl;
    link.download = `trellis-referral-qr-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center space-y-4 ${className}`}>
      <div className="relative group">
        <img
          src={qrCodeUrl}
          alt="QR Code"
          className="rounded-lg shadow-lg transition-transform duration-200 group-hover:scale-105"
          style={{ width: config.size || 200, height: config.size || 200 }}
        />
        <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-opacity duration-200 rounded-lg"></div>
      </div>
      
      <button
        onClick={downloadQRCode}
        className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors duration-200 text-sm font-medium"
      >
        Download QR Code
      </button>
    </div>
  );
};

export default QRCodeGenerator;

