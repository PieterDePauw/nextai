import { NextRequest, NextResponse } from 'next/server';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_KEY } from './config';
import type { EmbeddingSource } from './types';
import dotenv from 'dotenv';
import { walk } from './githubUtils';
import { processMdxForSearch } from './mdxUtils';
import { generateEmbeddings } from './embeddingUtils';
import { storePageInSupabase } from './supabaseUtils';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

async function generateEmbeddingsHandler() {
	const shouldRefresh = false;

	if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_KEY) {
		return console.log('Environment variables SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENAI_KEY are required: skipping embeddings generation');
	}

	const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

	// If the refresh flag is set, delete all existing data
	if (shouldRefresh) {
		console.log('Refresh flag set, deleting existing data...')
		const { error: deletePageSectionError } = await supabaseClient
			.from('nods_page_section')
			.delete()
		if (deletePageSectionError) {
			throw deletePageSectionError
		}

		const { error: deletePageError } = await supabaseClient
			.from('nods_page')
			.delete()
		if (deletePageError) {
			throw deletePageError
		}
	}
	// Otherwise, check which pages are new or have changed
	if (!shouldRefresh) {
		console.log('Checking which pages are new or have changed')
	}

	const embeddingSources: EmbeddingSource[] = [
		...(await walk('docs'))
			.filter(({ path }) => /\.mdx?$/.test(path))
			.map((entry) => new GithubEmbeddingSource('guide', entry.path)),
	]

	console.log(`Discovered ${embeddingSources.length} pages`)

	// If the refresh flag is set, delete all existing data
	if (shouldRefresh) {
		console.log('Refresh flag set, re-generating all pages')
	}

	// Otherwise, check which pages are new or have changed
	if (!shouldRefresh) {
		console.log('Checking which pages are new or have changed')
	}




	console.log(`Discovered ${embeddingSources.length} pages`);

	for (const embeddingSource of embeddingSources) {
		try {
			const processedMdx = processMdxForSearch(embeddingSource); // Assuming processMdxForSearch takes embeddingSource as an argument
			const sectionsWithEmbeddings = await generateEmbeddings(processedMdx);

			await storePageInSupabase({
				...processedMdx,
				sections: sectionsWithEmbeddings,
			});

		} catch (err) {
			console.error(`Page failed to store properly.`);
			console.error(err);
		}
	}

	console.log('Embedding generation complete');
}

export async function GET(req: NextRequest) {
	try {
		await generateEmbeddingsHandler();
		return new NextResponse('Embeddings generated successfully.');
	} catch (error) {
		console.log(error);
		return new NextResponse('Embeddings generation failed.');
	}
}
