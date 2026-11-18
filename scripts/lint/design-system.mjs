// The design system's rules, as an oxlint plugin: `pnpm lint` loads it from .oxlintrc.json for
// apps/desktop and packages/ui. They follow Flux's, and check what a machine can: colours come
// from the tokens (packages/ui/src/styles/tokens.css), and the app uses packages/ui's controls,
// imported one component at a time. Disable one only with a reason:
//
//   // eslint-disable-next-line trioditis/no-raw-control -- why this one can't use packages/ui

// A hex colour (#fff, #ffff, #ffffff, #ffffffff) that is not part of a longer word or an
// address's fragment (/#add). An underscore is a space in a Tailwind arbitrary value, as in
// shadow-[0_1px_#000], so it does not join words here.
const HEX_COLOUR = /(?<![A-Za-z0-9&#/-])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![A-Za-z0-9-])/gi
// A CSS colour function. color-mix() is left alone: it mixes tokens.
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi
const TOKENS_HINT =
  'Use a token utility such as bg-surface or text-muted-foreground; tokens live in packages/ui/src/styles/tokens.css.'

// Controls packages/ui provides. Inside the app, use its component instead.
const CONTROLS = {
  button: 'Button from @trioditis/ui/button',
  input: 'Input from @trioditis/ui/input, or Switch from @trioditis/ui/switch',
  select: 'a menu from @trioditis/ui/dropdown-menu, or Segmented from @trioditis/ui/segmented',
  textarea: 'Input from @trioditis/ui/input',
}

// Where a string is a link, such as href="#add", a # starts a fragment, not a colour.
const LINK_KEYS = new Set(['href', 'to', 'hash'])

/** Whether `child` is part of the value `parent` produces, not, say, a condition it tests. */
function becomesValue(parent, child) {
  switch (parent.type) {
    case 'TemplateLiteral':
    case 'JSXExpressionContainer':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return true
    case 'ConditionalExpression':
      return parent.test !== child
    // The left of && is only tested; the left of || or ?? can be the value.
    case 'LogicalExpression':
      return parent.operator !== '&&' || parent.right === child
    case 'BinaryExpression':
      return parent.operator === '+'
    default:
      return false
  }
}

/** Whether a string ends up as a link: an href, to or hash attribute or property. */
function isLink(node) {
  let child = node
  let parent = node.parent
  while (parent && becomesValue(parent, child)) {
    child = parent
    parent = parent.parent
  }
  if (parent?.type === 'JSXAttribute') return LINK_KEYS.has(parent.name.name)
  if (parent?.type === 'Property' && parent.value === child) return LINK_KEYS.has(parent.key.name ?? parent.key.value)
  return false
}

// What may follow @trioditis/ui/: a component, a file under lib/, or one of the stylesheets,
// as packages/ui's package.json exports them.
const UI_IMPORT = /^@trioditis\/ui\/(?:[\w-]+|lib\/[\w-]+|[\w-]+\.css)$/

/** Reports every match of each pattern in every string and template literal. */
function checkStrings(context, patterns) {
  const check = (node, text) => {
    for (const { pattern, message } of patterns) {
      for (const match of text.matchAll(pattern)) context.report({ node, message: message(match[0]) })
    }
  }
  return {
    Literal(node) {
      if (typeof node.value !== 'string') return
      const parent = node.parent
      // Module names are not class names or colours.
      if (parent && 'source' in parent && parent.source === node) return
      if (isLink(node)) return
      check(node, node.value)
    },
    TemplateElement(node) {
      if (isLink(node)) return
      check(node, node.value.cooked ?? node.value.raw)
    },
  }
}

/** Whether `name`, where `node` uses it, is a binding imported from @trioditis/ui. */
function importedFromUi(context, node, name) {
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(name)
    // A type of the same name, such as a type parameter, doesn't hide a component.
    if (!variable || !variable.isValueVariable) continue
    // The nearest binding of the name is the one used, so a parameter or local of the same
    // name hides the import.
    const def = variable.defs[0]
    return (
      def?.type === 'ImportBinding' &&
      def.parent.type === 'ImportDeclaration' &&
      def.parent.source.value.startsWith('@trioditis/ui/')
    )
  }
  return false
}

/** Whether an element is a @trioditis/ui component with asChild on, so its child takes its look. */
function lendsItsLook(context, element) {
  if (element?.type !== 'JSXElement') return false
  let name = element.openingElement.name
  // <Dialog.Close asChild> is Dialog's.
  while (name.type === 'JSXMemberExpression') name = name.object
  if (name.type !== 'JSXIdentifier' || !importedFromUi(context, element, name.name)) return false
  const asChild = element.openingElement.attributes.find(
    (attr) => attr.type === 'JSXAttribute' && attr.name.name === 'asChild',
  )
  if (!asChild) return false
  // asChild, or asChild={true}.
  if (asChild.value === null) return true
  const value = asChild.value.type === 'JSXExpressionContainer' ? asChild.value.expression : asChild.value
  return value.type === 'Literal' && value.value === true
}

function importSource(context, node) {
  const source = node.source
  if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return
  const name = source.value
  if (name === '@trioditis/ui') {
    context.report({
      node: source,
      message: "Import each component from its own file, such as '@trioditis/ui/button'. @trioditis/ui has no index.",
    })
  } else if (name.startsWith('@trioditis/ui/') && !UI_IMPORT.test(name)) {
    context.report({
      node: source,
      message: `'${name}' reaches inside @trioditis/ui. Import the component by name, such as '@trioditis/ui/button', or '@trioditis/ui/lib/utils'.`,
    })
  } else if (/(?:^|\/)packages\/ui(?:\/|$)/.test(name)) {
    context.report({
      node: source,
      message: `Import packages/ui through @trioditis/ui, such as '@trioditis/ui/button', not by path ('${name}').`,
    })
  }
}

export default {
  meta: { name: 'trioditis' },
  rules: {
    'no-literal-colour': {
      meta: {
        type: 'problem',
        docs: { description: 'Colours come from the tokens, never literal values.' },
      },
      create: (context) =>
        checkStrings(context, [
          { pattern: HEX_COLOUR, message: (found) => `Literal colour ${found}. ${TOKENS_HINT}` },
          { pattern: COLOUR_FUNCTION, message: (found) => `Literal colour ${found}…). ${TOKENS_HINT}` },
        ]),
    },
    'no-raw-control': {
      meta: {
        type: 'problem',
        docs: { description: 'The app uses the controls in packages/ui, not one-off ones.' },
      },
      create: (context) => ({
        JSXOpeningElement(node) {
          if (node.name.type !== 'JSXIdentifier') return
          const use = CONTROLS[node.name.name]
          if (!use) return
          // An element a packages/ui component renders through asChild takes its look, as
          // <DropdownMenuItem asChild><button>…</button></DropdownMenuItem> does.
          if (lendsItsLook(context, node.parent?.parent)) return
          context.report({
            node,
            message: `One-off <${node.name.name}>. Use ${use}, or wrap it in a packages/ui component with asChild. If none fits, add one to packages/ui first.`,
          })
        },
      }),
    },
    'ui-imports': {
      meta: {
        type: 'problem',
        docs: { description: 'Import packages/ui one component at a time, through @trioditis/ui.' },
      },
      create: (context) => ({
        ImportDeclaration: (node) => importSource(context, node),
        ExportNamedDeclaration: (node) => importSource(context, node),
        ExportAllDeclaration: (node) => importSource(context, node),
        ImportExpression: (node) => importSource(context, node),
      }),
    },
  },
}
