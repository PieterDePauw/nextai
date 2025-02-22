import { OPENAI_KEY, OPENAI_MODEL, GITHUB_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_URL, ignoredDirectories, ignoredFiles } from './config';
import type { GithubFile, WalkEntry, Section, ProcessedMdx, Meta } from './types';

import axios from 'axios'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import dotenv from 'dotenv'
import { ObjectExpression } from 'estree'
import GithubSlugger from 'github-slugger'
import { Content, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { mdxFromMarkdown, MdxjsEsm } from 'mdast-util-mdx'
import { toMarkdown } from 'mdast-util-to-markdown'
import { toString } from 'mdast-util-to-string'
import { mdxjs } from 'micromark-extension-mdxjs'
import 'openai'
import { Configuration, OpenAIApi } from 'openai'
import { u } from 'unist-builder'
import { filter } from 'unist-util-filter'
import { inspect } from 'util'

dotenv.config()

/**
 * Extracts ES literals from an `estree` `ObjectExpression`
 * into a plain JavaScript object.
 */
function getObjectFromExpression(node: ObjectExpression): Record<string, string | number | bigint | true | RegExp | undefined> {
    return node.properties.reduce<
        Record<string, string | number | bigint | true | RegExp | undefined>
    >((object, property) => {
        if (property.type !== 'Property') {
            return object
        }

        const key = (property.key.type === 'Identifier' && property.key.name) || undefined
        const value = (property.value.type === 'Literal' && property.value.value) || undefined

        if (!key) {
            return object
        }

        return {
            ...object,
            [key]: value,
        }
    }, {})
}

/**
 * Extracts the `meta` ESM export from the MDX file.
 *
 * This info is akin to frontmatter.
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

    const objectExpression =
        (metaExportNode.data?.estree?.body[0]?.type === 'ExportNamedDeclaration' &&
            metaExportNode.data.estree.body[0].declaration?.type === 'VariableDeclaration' &&
            metaExportNode.data.estree.body[0].declaration.declarations[0]?.id.type === 'Identifier' &&
            metaExportNode.data.estree.body[0].declaration.declarations[0].id.name === 'meta' &&
            metaExportNode.data.estree.body[0].declaration.declarations[0].init?.type === 'ObjectExpression' &&
            metaExportNode.data.estree.body[0].declaration.declarations[0].init) ||
        undefined

    if (!objectExpression) {
        return undefined
    }

    return getObjectFromExpression(objectExpression)
}

/**
 * Splits a `mdast` tree into multiple trees based on
 * a predicate function. Will include the splitting node
 * at the beginning of each tree.
 *
 * Useful to split a markdown file into smaller sections.
 */
function splitTreeBy(tree: Root, predicate: (node: Content) => boolean) {
    return tree.children.reduce<Root[]>((trees, node) => {
        const [lastTree] = trees.slice(-1)

        if (!lastTree || predicate(node)) {
            const tree: Root = u('root', [node])
            return trees.concat(tree)
        }

        lastTree.children.push(node)
        return trees
    }, [])
}

/**
 * Processes MDX content for search indexing.
 * It extracts metadata, strips it of all JSX,
 * and splits it into sub-sections based on criteria.
 */
function processMdxForSearch(content: string): ProcessedMdx {
    if (content) content = content.replace(/(title:\s*)<([^>]+)>/g, '$1$2')

    const checksum = createHash('sha256').update(content).digest('base64')
    const mdxTree = fromMarkdown(content, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] })
    const meta = extractMetaExport(mdxTree)

    // Remove all MDX elements from markdown
    const mdTree = filter(mdxTree, (node) => !['mdxjsEsm', 'mdxJsxFlowElement', 'mdxJsxTextElement', 'mdxFlowExpression', 'mdxTextExpression'].includes(node.type))

    if (!mdTree) {
        return {
            checksum,
            meta,
            sections: [],
        }
    }

    const sectionTrees = splitTreeBy(mdTree, (node) => node.type === 'heading')
    const slugger = new GithubSlugger()

    const sections = sectionTrees.map((tree) => {
        let [firstNode] = tree.children
        const heading = firstNode.type === 'heading' ? toString(firstNode) : undefined
        const slug = heading ? slugger.slug(heading) : undefined

        return {
            content: toMarkdown(tree),
            heading: heading,
            slug,
        }
    })

    return {
        checksum,
        meta,
        sections,
    }
}

async function walk(dir: string, parentPath?: string): Promise<WalkEntry[]> {
    const response = await axios.get(`${GITHUB_URL}${dir}`, { headers: { Accept: 'application/vnd.github.v3+json', Authorization: `Bearer ${GITHUB_TOKEN}` } })

    const files: GithubFile[] = response.data

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

                if (isDir && isIgnored || isFile && isIgnored) { 	// e.g. Skip the "03-pages" subdirectory
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

    const flattenedFiles = entries.reduce((all, folderContents) => all.concat(folderContents), [])
    return flattenedFiles.sort((a, b) => a.path.localeCompare(b.path))
}

abstract class BaseEmbeddingSource {
    checksum?: string
    meta?: Meta
    sections?: Section[]

    constructor(
        public source: string,
        public path: string,
        public parentPath?: string
    ) {
    }

    abstract load(): Promise<{
        checksum: string
        meta?: Meta
        sections: Section[]
    }>
}

class GithubEmbeddingSource extends BaseEmbeddingSource {
    type: 'github' = 'github'

    constructor(
        source: string,
        public filePath: string,
        public parentFilePath?: string
    ) {
        const path = filePath.replace(/^docs/, '').replace(/\.mdx?$/, '')
        const parentPath = parentFilePath
            ?.replace(/^docs/, '')
            .replace(/\.mdx?$/, '')

        super(source, path, parentPath)
    }

    async load() {
        const response = await axios.get(`${GITHUB_URL}${this.filePath}`)

        const contents = response.data

        const { checksum, meta, sections } = processMdxForSearch(contents)

        this.checksum = checksum
        this.meta = meta
        this.sections = sections

        return {
            checksum,
            meta,
            sections,
        }
    }
}

type EmbeddingSource = GithubEmbeddingSource

async function generateEmbeddings() {
    const shouldRefresh = false

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_KEY) {
        return console.log('Environment variables NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OPENAI_KEY are required: skipping embeddings generation')
    }

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

    if (shouldRefresh) {
        console.log('Refresh flag set, deleting existing data...')

        const { error: deletePageSectionError } = await supabaseClient.from('nods_page_section').delete()
        if (deletePageSectionError) { throw deletePageSectionError }

        const { error: deletePageError } = await supabaseClient.from('nods_page').delete()
        if (deletePageError) { throw deletePageError }
    } else {
        console.log('Checking which pages are new or have changed')
    }

    const embeddingSources: EmbeddingSource[] = [
        ...(await walk('docs'))
            .filter(({ path }) => /\.mdx?$/.test(path))
            .map((entry) => new GithubEmbeddingSource('guide', entry.path)),
    ]

    console.log(`Discovered ${embeddingSources.length} pages`)

    if (shouldRefresh) {
        console.log('Refresh flag set, re-generating all pages')
    } else {
        console.log('Checking which pages are new or have changed')
    }

    for (const embeddingSource of embeddingSources) {
        const { type, source, path, parentPath } = embeddingSource

        try {
            const { checksum, meta, sections } = await embeddingSource.load()

            // Check for existing page in DB and compare checksums
            const { error: fetchPageError, data: existingPage } = await supabaseClient
                .from('nods_page')
                .select('id, path, checksum, parentPage:parent_page_id(id, path)')
                .filter('path', 'eq', path)
                .limit(1)
                .maybeSingle()

            if (fetchPageError) {
                throw fetchPageError
            }

            type Singular<T> = T extends any[] ? undefined : T

            // We use checksum to determine if this page & its sections need to be regenerated
            if (!shouldRefresh && existingPage?.checksum === checksum) {
                const existingParentPage = existingPage?.parentPage as unknown as Singular<typeof existingPage.parentPage>

                // If parent page changed, update it
                // @ts-ignore
                if (existingParentPage?.path !== parentPath) {
                    console.log(`[${path}] Parent page has changed. Updating to '${parentPath}'...`)
                    const { error: fetchParentPageError, data: parentPage } =
                        await supabaseClient
                            .from('nods_page')
                            .select()
                            .filter('path', 'eq', parentPath)
                            .limit(1)
                            .maybeSingle()

                    if (fetchParentPageError) {
                        throw fetchParentPageError
                    }

                    const { error: updatePageError } = await supabaseClient
                        .from('nods_page')
                        .update({ parent_page_id: parentPage?.id })
                        .filter('id', 'eq', existingPage.id)

                    if (updatePageError) {
                        throw updatePageError
                    }
                }
                continue
            }

            if (existingPage) {
                if (!shouldRefresh) {
                    console.log(`[${path}] Docs have changed, removing old page sections and their embeddings`)
                } else {
                    console.log(`[${path}] Refresh flag set, removing old page sections and their embeddings`)
                }

                const { error: deletePageSectionError } = await supabaseClient
                    .from('nods_page_section')
                    .delete()
                    .filter('page_id', 'eq', existingPage.id)

                if (deletePageSectionError) {
                    throw deletePageSectionError
                }
            }

            const { error: fetchParentPageError, data: parentPage } =
                await supabaseClient
                    .from('nods_page')
                    .select()
                    .filter('path', 'eq', parentPath)
                    .limit(1)
                    .maybeSingle()

            if (fetchParentPageError) {
                throw fetchParentPageError
            }

            // Create/update page record. Intentionally clear checksum until we
            // have successfully generated all page sections.
            const { error: upsertPageError, data: page } = await supabaseClient
                .from('nods_page')
                .upsert(
                    {
                        checksum: null,
                        path,
                        type,
                        source,
                        meta,
                        parent_page_id: parentPage?.id,
                    },
                    { onConflict: 'path' }
                )
                .select()
                .limit(1)
                .single()

            if (upsertPageError) {
                throw upsertPageError
            }

            console.log(`[${path}] Adding ${sections.length} page sections (with embeddings)`)

            for (const { slug, heading, content } of sections) {
                // OpenAI recommends replacing newlines with spaces for best results (specific to embeddings)
                const input = content.replace(/\n/g, ' ')

                try {
                    const configuration = new Configuration({ apiKey: OPENAI_KEY })
                    const openai = new OpenAIApi(configuration)
                    const embeddingResponse = await openai.createEmbedding({ model: OPENAI_MODEL, input })

                    if (embeddingResponse.status !== 200) {
                        throw new Error(inspect(embeddingResponse.data, false, 2))
                    }

                    const [responseData] = embeddingResponse.data.data

                    const { error: insertPageSectionError } =
                        await supabaseClient
                            .from('nods_page_section')
                            .insert({
                                page_id: page.id,
                                slug,
                                heading,
                                content,
                                token_count: embeddingResponse.data.usage.total_tokens,
                                embedding: responseData.embedding,
                            })
                            .select()
                            .limit(1)
                            .single()

                    if (insertPageSectionError) {
                        throw insertPageSectionError
                    }
                } catch (err) {
                    // TODO: decide how to better handle failed embeddings
                    console.error(`Failed to generate embeddings for '${path}' page section starting with '${input.slice(0, 40)}...'`)
                    throw err
                }
            }

            // Set page checksum so that we know this page was stored successfully
            const { error: updatePageError } = await supabaseClient
                .from('nods_page')
                .update({ checksum })
                .filter('id', 'eq', page.id)

            if (updatePageError) {
                throw updatePageError
            }
        } catch (err) {
            console.error(`Page '${path}' or one/multiple of its page sections failed to store properly. Page has been marked with null checksum to indicate that it needs to be re-generated.`)
            console.error(err)
        }
    }

    console.log('Embedding generation complete')
}

async function main() {
    await generateEmbeddings()
}

main().catch((err) => console.error(err))
