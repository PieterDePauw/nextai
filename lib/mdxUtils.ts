// mdxUtils.ts

import { ObjectExpression } from 'estree';
import { Root, Content } from 'mdast';
import { createHash } from 'crypto';
import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { mdxjs } from 'micromark-extension-mdxjs';
import { filter } from 'unist-util-filter';
import { mdxFromMarkdown, MdxjsEsm } from 'mdast-util-mdx'
import { u } from 'unist-builder'
import { ProcessedMdx } from './types';

/**
 * Extracts ES literals from an `estree` `ObjectExpression`
 * into a plain JavaScript object.
 */
export function getObjectFromExpression(node: ObjectExpression) {
	return node.properties.reduce<Record<string, string | number | bigint | true | RegExp | undefined>>((object, property) => {
		if (property.type !== 'Property') {
			return object;
		}

		const key = (property.key.type === 'Identifier' && property.key.name) || undefined;
		const value = (property.value.type === 'Literal' && property.value.value) || undefined;

		if (!key) {
			return object;
		}

		return {
			...object,
			[key]: value,
		};
	}, {});
}

/**
 * Extracts the `meta` ESM export from the MDX file.
 * This info is akin to frontmatter.
 */

export function extractMetaExport(mdxTree: Root) {
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
 */
export function splitTreeBy(tree: Root, predicate: (node: Content) => boolean) {
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
 */
export function processMdxForSearch(content: string): ProcessedMdx {
	if (content) content = content.replace(/(title:\s*)<([^>]+)>/g, '$1$2')

	const checksum = createHash('sha256').update(content).digest('base64')
	const mdxTree = fromMarkdown(content, {
		extensions: [mdxjs()],
		mdastExtensions: [mdxFromMarkdown()],
	})

	const meta = extractMetaExport(mdxTree)

	// Remove all MDX elements from markdown
	const mdTree = filter(
		mdxTree,
		(node) =>
			![
				'mdxjsEsm',
				'mdxJsxFlowElement',
				'mdxJsxTextElement',
				'mdxFlowExpression',
				'mdxTextExpression',
			].includes(node.type)
	)

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

		const heading =
			firstNode.type === 'heading' ? firstNode.toString() : undefined

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

export type Meta = ReturnType<typeof extractMetaExport>