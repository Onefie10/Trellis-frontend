'use client';

import React from 'react';
import { sanitizeHtml, sanitizeMarkdown, stripControlAndBidi } from '@/lib/security/content-sanitizer';
import DOMPurify from 'dompurify';

export interface SafeContentProps {
  content: string;
  type?: 'html' | 'markdown' | 'text';
  className?: string;
}

/**
 * Renders user-provided content safely by applying robust sanitization.
 */
export const SafeContent: React.FC<SafeContentProps> = ({
  content,
  type = 'text',
  className = '',
}) => {
  if (type === 'html') {
    const cleanHtml = DOMPurify.sanitize(sanitizeHtml(content), { USE_PROFILES: { html: true } });
    return <div className={className} dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
  }

  if (type === 'markdown') {
    const cleanMd = sanitizeMarkdown(content);
    return <div className={`whitespace-pre-wrap ${className}`}>{cleanMd}</div>;
  }

  const cleanText = stripControlAndBidi(content);
  return <span className={className}>{cleanText}</span>;
};
