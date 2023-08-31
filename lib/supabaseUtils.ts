// supabaseUtils.ts

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from './config';

export const supabaseClient = createClient(
	SUPABASE_URL,
	SUPABASE_SERVICE_ROLE_KEY,
	{
		auth: {
			persistSession: false,
			autoRefreshToken: false,
		},
	}
);

/**
 * Deletes existing data from Supabase tables.
 */
export async function deleteExistingData() {
	const { error: deletePageSectionError } = await supabaseClient
		.from('nods_page_section')
		.delete();

	if (deletePageSectionError) {
		throw deletePageSectionError;
	}

	const { error: deletePageError } = await supabaseClient
		.from('nods_page')
		.delete();

	if (deletePageError) {
		throw deletePageError;
	}
}

/**
 * Stores the processed MDX page in the Supabase database.
 * @param {Object} pageData - The data related to the MDX page.
 */
export async function storePageInSupabase(pageData: any) {
	// Original logic for storing the page and its sections in Supabase

	// Upsert page data
	const { error: upsertPageError } = await supabaseClient
		.from('nods_page')
		.upsert(
			{
				checksum: null,
				path: pageData.path,
				type: pageData.type,
				source: pageData.source,
				meta: pageData.meta,
				parent_page_id: pageData.parentPage?.id,
			},
			{ onConflict: 'path' }
		)
		.select()
		.limit(1)
		.single();

	if (upsertPageError) {
		throw upsertPageError;
	}

	// More logic for storing sections, etc.
}
