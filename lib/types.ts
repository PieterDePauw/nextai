// types.ts
import type { Meta } from './mdxUtils.ts';

type GithubFile = {
	type: 'file' | 'dir';
	name: string;
};

type Section = {
	content: string
	heading?: string
	slug?: string
}

type ProcessedMdx = {
	checksum: string
	meta: Meta
	sections: Section[]
}

type WalkEntry = {
	path: string;
	parentPath?: string;
};

type GithubEmbeddingSource = {
	type: 'github'
	owner: string
	repo: string
	path: string
}

type EmbeddingSource = GithubEmbeddingSource

export type { GithubFile, Meta, Section, ProcessedMdx, WalkEntry, EmbeddingSource, GithubEmbeddingSource };
