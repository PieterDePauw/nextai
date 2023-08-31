// embeddingUtils.ts

import { Configuration, OpenAIApi } from 'openai';
import { ProcessedMdx, Section } from './types';
import { OPENAI_KEY, OPENAI_MODEL } from './config';
import { inspect } from 'util';

/**
 * Generates embeddings for each section of a given MDX content.
 * @param {ProcessedMdx} processedMdx - The processed MDX content.
 * @returns {Promise<Section[]>} - A Promise resolving to an array of sections with embeddings.
 */
export const generateEmbeddings = async (processedMdx: ProcessedMdx): Promise<Section[]> => {
	const { /*checksum, meta,*/ sections } = processedMdx;
	const configuration = new Configuration({ apiKey: OPENAI_KEY });
	const openai = new OpenAIApi(configuration);

	// Loop through sections to generate embeddings
	for (const section of sections) {
		// OpenAI recommends replacing newlines with spaces for best results (specific to embeddings)
		const input = section.content.replace(/\n/g, ' ');

		try {
			const embeddingResponse = await openai.createEmbedding({ model: OPENAI_MODEL, input });

			if (embeddingResponse.status !== 200) {
				throw new Error(inspect(embeddingResponse.data, false, 2));
			}

			const [responseData] = embeddingResponse.data.data;
			section.embedding = responseData.embedding;

		} catch (err) {
			// TODO: decide how to better handle failed embeddings
			console.error(`Failed to generate embeddings for section starting with '${input.slice(0, 40)}...'`);
			throw err;
		}
	}

	return sections;
};
