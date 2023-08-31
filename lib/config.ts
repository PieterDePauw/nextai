// config.ts
import dotenv from 'dotenv';
dotenv.config();

export const GITHUB_URL = process.env.GITHUB_URL || 'https://api.github.com/repos/vercel/next.js/contents/';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const OPENAI_KEY = process.env.OPENAI_KEY || '';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'text-embedding-ada-002';
export const ignoredDirectories = ['03-pages'];
export const ignoredFiles = ['_app.mdx', '_document.mdx', '_error.mdx'];
