/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Image Extractor — Generic Page Image Extraction & Upload
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  Extracts images from any page (including blob: URLs), uploads them
 *           to the bridge server, and returns markdown-compatible links.
 *
 * Extracted from gemini-strategy.js — made fully site-agnostic.
 *
 * Usage:
 *   const result = await BrowserAgent.ImageExtractor.extractFromPage();
 *   // result.images — array of { src, alt, width, height, uploaded, bridgeUrl }
 *   // result.text   — markdown summary of extracted images
 *
 * Ref: Implementation Plan — Strategy-to-Brain Migration
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.ImageExtractor = (() => {
  'use strict';

  const BRIDGE_URL = 'http://localhost:3847';

  /**
   * Extract all visible, meaningful images from the current page.
   * Filters out tiny icons, tracking pixels, and decorative images.
   *
   * @param {Object} [options={}]
   * @param {number} [options.minWidth=50]  Minimum image width
   * @param {number} [options.minHeight=50] Minimum image height
   * @param {boolean} [options.upload=true] Upload to bridge server
   * @returns {Promise<Object>} Extraction result
   */
  async function extractFromPage(options = {}) {
    const minWidth = options.minWidth || 50;
    const minHeight = options.minHeight || 50;
    const shouldUpload = options.upload !== false;

    console.log('[ImageExtractor] Scanning page for images...');

    const imgElements = Array.from(document.querySelectorAll('img'));
    const results = [];

    for (const img of imgElements) {
      // Skip invisible images
      if (!img.offsetParent && window.getComputedStyle(img).display === 'none') continue;

      const rect = img.getBoundingClientRect();
      // Skip tiny images (icons, tracking pixels)
      if (rect.width < minWidth || rect.height < minHeight) continue;

      const src = img.src || img.currentSrc || '';
      if (!src) continue;

      const entry = {
        src,
        alt: img.alt || '',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        isBlob: src.startsWith('blob:'),
        uploaded: false,
        bridgeUrl: null
      };

      // Handle blob: URLs — convert to binary and upload
      if (entry.isBlob && shouldUpload) {
        try {
          const uploaded = await _uploadBlobImage(src, entry.alt);
          if (uploaded) {
            entry.uploaded = true;
            entry.bridgeUrl = uploaded.url;
          }
        } catch (e) {
          console.warn('[ImageExtractor] Blob upload failed:', e.message);
        }
      }
      // Handle regular URLs — upload if requested
      else if (shouldUpload && !entry.isBlob) {
        try {
          const uploaded = await _uploadRemoteImage(src, entry.alt);
          if (uploaded) {
            entry.uploaded = true;
            entry.bridgeUrl = uploaded.url;
          }
        } catch (e) {
          console.warn('[ImageExtractor] Image upload failed:', e.message);
        }
      }

      results.push(entry);
    }

    // Also check for CSS background images in main content areas
    const bgImages = _extractBackgroundImages(minWidth, minHeight);
    results.push(...bgImages);

    // Build text summary
    const lines = [`Found ${results.length} image(s) on page.`];
    for (let i = 0; i < results.length; i++) {
      const img = results[i];
      const label = img.alt || `Image ${i + 1}`;
      if (img.bridgeUrl) {
        lines.push(`![${label}](${img.bridgeUrl})`);
      } else {
        lines.push(`- ${label} (${img.width}x${img.height}) — ${img.src.substring(0, 80)}`);
      }
    }

    console.log(`[ImageExtractor] Extracted ${results.length} images`);

    return {
      images: results,
      text: lines.join('\n')
    };
  }

  /**
   * Upload a blob: URL image to the bridge server.
   * Fetches the blob, converts to base64, POSTs to bridge.
   */
  async function _uploadBlobImage(blobUrl, alt) {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Convert to base64
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);

    const mimeType = blob.type || 'image/png';
    const filename = `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${mimeType.includes('jpeg') ? 'jpg' : 'png'}`;

    const uploadResult = await fetch(`${BRIDGE_URL}/api/upload-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename,
        data: base64,
        mimeType,
        alt: alt || filename
      })
    });

    if (uploadResult.ok) {
      const data = await uploadResult.json();
      console.log(`[ImageExtractor] Blob uploaded: ${filename}`);
      return { url: data.url || `${BRIDGE_URL}/uploads/${filename}` };
    }
    return null;
  }

  /**
   * Upload a remote image URL to the bridge server.
   * The bridge server will download and cache it.
   */
  async function _uploadRemoteImage(imageUrl, alt) {
    try {
      const uploadResult = await fetch(`${BRIDGE_URL}/api/upload-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: imageUrl,
          alt: alt || 'extracted_image'
        })
      });

      if (uploadResult.ok) {
        const data = await uploadResult.json();
        return { url: data.url || imageUrl };
      }
    } catch (e) {
      // Bridge may not support /api/upload-image — just return the original URL
    }
    return null;
  }

  /**
   * Extract CSS background-image URLs from main content elements.
   */
  function _extractBackgroundImages(minWidth, minHeight) {
    const results = [];
    const mainContent = document.querySelector('[role="main"], #main, main, .main-content, article');
    if (!mainContent) return results;

    const elements = mainContent.querySelectorAll('*');
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const bgImage = style.backgroundImage;
      if (!bgImage || bgImage === 'none') continue;

      const urlMatch = bgImage.match(/url\(['"]?(.*?)['"]?\)/);
      if (!urlMatch) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < minWidth || rect.height < minHeight) continue;

      results.push({
        src: urlMatch[1],
        alt: 'background-image',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        isBlob: urlMatch[1].startsWith('blob:'),
        uploaded: false,
        bridgeUrl: null,
        type: 'background'
      });
    }

    return results;
  }

  return {
    extractFromPage,
    _uploadBlobImage,
    _uploadRemoteImage
  };
})();
