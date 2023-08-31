// githubUtils.ts

import axios from 'axios';
import { join } from 'path';
import { GithubFile, WalkEntry } from './types';
import { GITHUB_URL, GITHUB_TOKEN, ignoredDirectories, ignoredFiles } from './config';

/**
 * Asynchronously walk through the GitHub repository's directory structure to find MDX files.
 * @param {string} dir - The directory to start walking from.
 * @param {string} [parentPath] - The parent directory path.
 * @returns {Promise<WalkEntry[]>} - A Promise resolving to an array of WalkEntry objects.
 */
export const walk = async (dir: string, parentPath?: string): Promise<WalkEntry[]> => {
	const response = await axios.get(`${GITHUB_URL}${dir}`,
		{
			headers: {
				'Accept': 'application/vnd.github.v3+json',
				'Authorization': `Bearer ${GITHUB_TOKEN}`,
			},
		}
	);

	const files: GithubFile[] = response.data;

	const entries = await Promise.all(
		files.map(
			async (file) => {
				const path = join(dir, file.name);

				const isDir = file.type === 'dir';
				const isFile = file.type === 'file';
				const isIgnoredDir = ignoredDirectories.includes(file.name) && file.type === 'dir';
				const isIgnoredFile = ignoredFiles.includes(file.name) && file.type === 'file';
				const isIgnored = isIgnoredDir || isIgnoredFile;
				const hasMdxFileExtension = /\.mdx?$/.test(file.name) && file.type === 'file';

				if (isIgnored) { 	// e.g. Skip the "03-pages" subdirectory
					return [];
				} else if (isDir && !isIgnored) {
					return walk(path, parentPath);
				} else if (isFile && !isIgnored && hasMdxFileExtension) {
					return [{ path: path, parentPath }];
				} else {
					return [];
				}
			})
	);

	const flattenedFiles = entries.reduce((all, folderContents) => all.concat(folderContents), []);

	return flattenedFiles.sort((a, b) => a.path.localeCompare(b.path));
};

