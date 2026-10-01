// Bundled into public/vendor/blob-upload.js (npm run vendor) so the browser can upload
// straight to Vercel Blob without a build step at deploy time.
export { upload } from '@vercel/blob/client';
