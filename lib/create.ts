// ----------------- Imports -----------------
// Configuration and Types
import {
	OPENAI_KEY,
	GITHUB_TOKEN,
	SUPABASE_URL,
	ignoredDirectories,
	ignoredFiles,
	GITHUB_URL,
	SUPABASE_SERVICE_ROLE_KEY,
	OPENAI_MODEL,
} from "./config";
import type {
	GithubFile,
	WalkEntry,
	Section,
	ProcessedMdx,
	Meta,
} from "./types";

// Libraries
import axios from "axios";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import dotenv from "dotenv";

// Markdown Utilities (assuming these are the same as in the original code)
import GithubSlugger from "github-slugger";
import { Content, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mdxFromMarkdown, MdxjsEsm } from "mdast-util-mdx";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString } from "mdast-util-to-string";
import { mdxjs } from "micromark-extension-mdxjs";
import { Configuration, OpenAIApi } from "openai";
import { u } from "unist-builder";
import { filter } from "unist-util-filter";
import { ObjectExpression } from "estree";

dotenv.config();

// ----------------- Utility Functions -----------------

/**
 * Converts an ObjectExpression node into a plain JavaScript object.
 */
function getObjectFromExpression(node: ObjectExpression): Record<string, any> {
	return node.properties.reduce<Record<string, any>>(
		(object, property) => {
			if (property.type !== "Property") {
				return object;
			}

			const key =
				property.key.type === "Identifier" ? property.key.name : undefined;
			const value =
				property.value.type === "Literal" ? property.value.value : undefined;

			if (!key) {
				return object;
			}

			return {
				...object,
				[key]: value,
			};
		},
		{}
	);
}

/**
 * Extracts the meta information from an MDX file.
 */
function extractMetaExport(mdxTree: Root) {
	const metaExportNode = mdxTree.children.find((node): node is MdxjsEsm => {
		return (
			node.type === 'mdxjsEsm' &&
			node.data?.estree?.body[0]?.type === 'ExportNamedDeclaration' &&
			node.data.estree.body[0].declaration?.type === 'VariableDeclaration' &&
			node.data.estree.body[0].declaration.declarations[0]?.id.type === 'Identifier' &&
			node.data.estree.body[0].declaration.declarations[0].id.name === 'meta'
		)
	})

	if (!metaExportNode) {
		return undefined
	}

	const objectExpression = (
		metaExportNode.data?.estree?.body[0]?.type === 'ExportNamedDeclaration' &&
		metaExportNode.data.estree.body[0].declaration?.type === 'VariableDeclaration' &&
		metaExportNode.data.estree.body[0].declaration.declarations[0]?.id.type === 'Identifier' &&
		metaExportNode.data.estree.body[0].declaration.declarations[0].id.name === 'meta' &&
		metaExportNode.data.estree.body[0].declaration.declarations[0].init?.type === 'ObjectExpression' &&
		metaExportNode.data.estree.body[0].declaration.declarations[0].init
	) || undefined

	if (!objectExpression) {
		return undefined
	}

	return getObjectFromExpression(objectExpression)
}

/**
 * Splits an MDX tree into multiple sub-trees based on a condition.
 */
function splitTreeBy(tree: Root, predicate: (node: Content) => boolean): Root[] {
	return tree.children.reduce<Root[]>((trees, node) => {
		const lastTree = trees.slice(-1)[0];

		if (!lastTree || predicate(node)) {
			const newTree: Root = u("root", [node]);
			return [...trees, newTree];
		}

		lastTree.children.push(node);
		return trees;
	}, []);
}

/**
 * Processes MDX content for search indexing.
 */
function processMdxForSearch(content: string): ProcessedMdx {
	let checksum = createHash("sha256").update(content).digest("base64");
	const mdxTree = fromMarkdown(content, {
		extensions: [mdxjs()],
		mdastExtensions: [mdxFromMarkdown()],
	});
	const meta = extractMetaExport(mdxTree);

	// Remove all MDX elements from markdown
	const mdTree = filter(
		mdxTree,
		(node) =>
			![
				"mdxjsEsm",
				"mdxJsxFlowElement",
				"mdxJsxTextElement",
				"mdxFlowExpression",
				"mdxTextExpression",
			].includes(node.type)
	)

	if (!mdTree) {
		return {
			checksum,
			meta,
			sections: [],
		};
	}

	const sectionTrees = splitTreeBy(mdTree, (node) => node.type === "heading");
	const slugger = new GithubSlugger();

	const sections = sectionTrees.map((tree) => {
		const firstNode = tree.children[0];
		const heading =
			firstNode.type === "heading" ? toString(firstNode) : undefined;
		const slug = heading ? slugger.slug(heading) : undefined;

		return {
			content: toMarkdown(tree),
			heading,
			slug,
		};
	});

	return {
		checksum,
		meta,
		sections,
	};
}

/**
 * Walks a GitHub directory and returns its files.
 */
async function walkGithubDirectory(dir: string): Promise<WalkEntry[]> {
	const response = await axios.get(`${GITHUB_URL}${dir}`, {
		headers: {
			Accept: "application/vnd.github.v3+json",
			Authorization: `Bearer ${GITHUB_TOKEN}`,
		},
	});

	const files: GithubFile[] = response.data;

	const entries = await Promise.all(
		files.map(async (file) => {
			const path = join(dir, file.name);
			const isDir = file.type === "dir";
			const isFile = file.type === "file";
			const isIgnoredDir = ignoredDirectories.includes(file.name) && isDir;
			const isIgnoredFile = ignoredFiles.includes(file.name) && isFile;
			const isIgnored = isIgnoredDir || isIgnoredFile;
			const hasMdxFileExtension = /\.mdx?$/.test(file.name) && isFile;

			if (isIgnored) {
				return [];
			} else if (isDir) {
				return walkGithubDirectory(path);
			} else if (isFile && hasMdxFileExtension) {
				return [{ path, parentPath: dir }];
			} else {
				return [];
			}
		})
	);

	return entries.flat().sort((a, b) => a.path.localeCompare(b.path));
}

// ----------------- Classes -----------------

/**
 * Abstract class for embedding sources.
 */
abstract class BaseEmbeddingSource {
	constructor(
		public source: string,
		public path: string,
		public parentPath?: string
	) { }

	abstract load(): Promise<{
		checksum: string;
		meta?: Meta;
		sections: Section[];
	}>;
}

/**
 * Concrete class for GitHub as an embedding source.
 */
class GithubEmbeddingSource extends BaseEmbeddingSource {
	type: "github" = "github";

	constructor(source: string, filePath: string, parentFilePath?: string) {
		const path = filePath.replace(/^docs/, "").replace(/\.mdx?$/, "");
		const parentPath = parentFilePath
			?.replace(/^docs/, "")
			.replace(/\.mdx?$/, "");
		super(source, path, parentPath);
	}

	async load(): Promise<{
		checksum: string;
		meta?: Meta;
		sections: Section[];
	}> {
		const response = await axios.get(`${GITHUB_URL}${this.path}`);
		const contents = response.data;
		return processMdxForSearch(contents);
	}
}
// ----------------- Main Logic -----------------

/**
 * Generates embeddings for the content.
 */
async function generateEmbeddings() {
	if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_KEY) {
		return console.log(
			"Environment variables SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENAI_KEY are required: skipping embeddings generation"
		);
	}

	const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false },
	});

	const shouldRefresh = false;
	if (shouldRefresh) {
		console.log("Refresh flag set, deleting existing data...");
		await supabaseClient.from("nods_page_section").delete();
		await supabaseClient.from("nods_page").delete();
	} else {
		console.log("Checking which pages are new or have changed");
	}

	const embeddingSources: GithubEmbeddingSource[] = await walkGithubDirectory(
		"docs"
	)
		.then((entries) =>
			entries.filter(({ path }) => /\.mdx?$/.test(path))
		)
		.then((entries) =>
			entries.map((entry) => new GithubEmbeddingSource("guide", entry.path))
		);

	console.log(`Discovered ${embeddingSources.length} pages`);

	for (const embeddingSource of embeddingSources) {
		const { type, source, path } = embeddingSource;

		try {
			const { checksum, meta, sections } = await embeddingSource.load();

			// Check for existing page in DB and compare checksums
			const { data: existingPage } = await supabaseClient
				.from("nods_page")
				.select("id, path, checksum")
				.eq("path", path)
				.limit(1)
				.single();

			// Conditionally handle existing pages
			if (existingPage?.checksum === checksum && !shouldRefresh) {
				continue;
			}

			// Delete old page sections if they exist
			if (existingPage) {
				await supabaseClient
					.from("nods_page_section")
					.delete()
					.eq("page_id", existingPage.id);
			}

			// Upsert new page record
			const { data: page } = await supabaseClient
				.from("nods_page")
				.upsert(
					{
						checksum: null,
						path,
						type,
						source,
						meta,
					},
					{ onConflict: "path" }
				)
				.single();

			// Process each section for embedding
			// Process each section for embedding
			if (page) {
				for (const { slug, heading, content } of sections) {
					const input = content.replace(/\n/g, " ");
					const configuration = new Configuration({ apiKey: OPENAI_KEY });
					const openai = new OpenAIApi(configuration);
					const embeddingResponse = await openai.createEmbedding({
						model: OPENAI_MODEL,
						input,
					});

					if (embeddingResponse.status !== 200) {
						throw new Error(`Failed to generate embedding for section: ${slug}`);
					}

					const [embeddingData] = embeddingResponse.data.data;

					await supabaseClient.from("nods_page_section").insert({
						page_id: (page as { id: number }[])[0].id,
						slug,
						heading,
						content,
						token_count: embeddingResponse.data.usage.total_tokens,
						embedding: embeddingData.embedding,
					});
				}
			}

		} catch (err) {
			console.error(`Error processing page ${path}: ${(err as Error).message}`);
		}
	}

	console.log("Embedding generation complete");
}

// ----------------- Entry Point -----------------

/**
 * Main function to kick off the processing.
 */
async function main() {
	await generateEmbeddings();
}

// Handle errors at the top-level
main().catch((err) => console.error(err));

