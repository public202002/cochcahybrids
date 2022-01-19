import global from "../global.js";
import { stringifyElement, shadyCSS, probablyDevMode } from "../utils.js";
import { get as getMessage } from "../localize.js";

import { dataMap, removeTemplate } from "./utils.js";

import resolveValue from "./resolvers/value.js";
import resolveProperty from "./resolvers/property.js";

const TIMESTAMP = Date.now();

export const getPlaceholder = (id = 0) => `H-${TIMESTAMP}-${id}`;

const PLACEHOLDER_REGEXP_TEXT = getPlaceholder("(\\d+)");
const PLACEHOLDER_REGEXP_EQUAL = new RegExp(`^${PLACEHOLDER_REGEXP_TEXT}$`);
const PLACEHOLDER_REGEXP_ALL = new RegExp(PLACEHOLDER_REGEXP_TEXT, "g");
const PLACEHOLDER_REGEXP_ONLY = /^[${}0-9 \t\n\f\r]+$/;

const preparedTemplates = new WeakMap();

/* istanbul ignore next */
function applyShadyCSS(template, tagName) {
  if (!tagName) return template;

  return shadyCSS((shady) => {
    let map = preparedTemplates.get(template);
    if (!map) {
      map = new Map();
      preparedTemplates.set(template, map);
    }

    let clone = map.get(tagName);

    if (!clone) {
      clone = global.document.createElement("template");
      clone.content.appendChild(template.content.cloneNode(true));

      map.set(tagName, clone);

      const styles = clone.content.querySelectorAll("style");

      Array.from(styles).forEach((style) => {
        const count = style.childNodes.length + 1;
        for (let i = 0; i < count; i += 1) {
          style.parentNode.insertBefore(
            global.document.createTextNode(getPlaceholder()),
            style,
          );
        }
      });

      shady.prepareTemplate(clone, tagName.toLowerCase());
    }
    return clone;
  }, template);
}

function createSignature(parts, styles) {
  let signature = parts.reduce((acc, part, index) => {
    if (index === 0) {
      return part;
    }

    if (
      parts
        .slice(index)
        .join("")
        .match(/^\s*<\/\s*(table|tr|thead|tbody|tfoot|colgroup)>/)
    ) {
      return `${acc}<!--${getPlaceholder(index - 1)}-->${part}`;
    }
    return acc + getPlaceholder(index - 1) + part;
  }, "");

  if (styles) {
    signature += `<style>\n${styles.join("\n/*------*/\n")}\n</style>`;
  }

  return signature;
}

function getPropertyName(string) {
  return string
    .replace(/\s*=\s*['"]*$/g, "")
    .split(/\s+/)
    .pop();
}

function replaceComments(fragment) {
  const iterator = global.document.createNodeIterator(
    fragment,
    global.NodeFilter.SHOW_COMMENT,
    null,
    false,
  );
  let node;
  // eslint-disable-next-line no-cond-assign
  while ((node = iterator.nextNode())) {
    if (PLACEHOLDER_REGEXP_EQUAL.test(node.textContent)) {
      node.parentNode.insertBefore(
        global.document.createTextNode(node.textContent),
        node,
      );
      node.parentNode.removeChild(node);
    }
  }
}

export function createInternalWalker(context) {
  let node;

  return {
    get currentNode() {
      return node;
    },
    nextNode() {
      if (node === undefined) {
        node = context.childNodes[0];
      } else if (node.childNodes.length) {
        node = node.childNodes[0];
      } else if (node.nextSibling) {
        node = node.nextSibling;
      } else {
        let parentNode = node.parentNode;
        node = parentNode.nextSibling;

        while (!node && parentNode !== context) {
          parentNode = parentNode.parentNode;
          node = parentNode.nextSibling;
        }
      }

      return !!node;
    },
  };
}

function createExternalWalker(context) {
  return global.document.createTreeWalker(
    context,
    // eslint-disable-next-line no-bitwise
    global.NodeFilter.SHOW_ELEMENT | global.NodeFilter.SHOW_TEXT,
    null,
    false,
  );
}

/* istanbul ignore next */
const createWalker =
  typeof global.ShadyDOM === "object" && global.ShadyDOM.inUse
    ? createInternalWalker
    : createExternalWalker;

const styleSheetsMap = new Map();

function normalizeWhitespace(input, startIndent = 0) {
  input = input.replace(/(^[\n\s\t ]+)|([\n\s\t ]+$)+/g, "");

  let i = input.indexOf("\n");
  if (i > -1) {
    let indent = 0 - startIndent - 2;
    for (i += 1; input[i] === " " && i < input.length; i += 1) {
      indent += 1;
    }
    return input.replace(/\n +/g, (t) =>
      t.substr(0, Math.max(t.length - indent, 1)),
    );
  }

  return input;
}

function beautifyTemplateLog(input, index) {
  const placeholder = getPlaceholder(index);

  const output = normalizeWhitespace(input)
    .split("\n")
    .filter((i) => i)
    .map((line) => {
      const startIndex = line.indexOf(placeholder);

      if (startIndex > -1) {
        return `| ${line}\n--${"-".repeat(startIndex)}${"^".repeat(6)}`;
      }

      return `| ${line}`;
    })
    .join("\n")
    // eslint-disable-next-line no-template-curly-in-string
    .replace(PLACEHOLDER_REGEXP_ALL, "${...}");

  return `${output}`;
}

export function compileTemplate(rawParts, isSVG, styles, translate = true) {
  const template = global.document.createElement("template");
  const parts = [];

  const signature = createSignature(rawParts, styles);
  template.innerHTML = isSVG ? `<svg>${signature}</svg>` : signature;

  if (isSVG) {
    const svgRoot = template.content.firstChild;
    template.content.removeChild(svgRoot);
    Array.from(svgRoot.childNodes).forEach((node) =>
      template.content.appendChild(node),
    );
  }

  replaceComments(template.content);

  const compileWalker = createWalker(template.content);
  const notDefinedElements = [];
  let compileIndex = 0;
  let noTranslate = null;

  while (compileWalker.nextNode()) {
    const node = compileWalker.currentNode;

    if (noTranslate && !noTranslate.contains(node)) {
      noTranslate = null;
    }

    if (node.nodeType === global.Node.TEXT_NODE) {
      let text = node.textContent;

      if (!text.match(PLACEHOLDER_REGEXP_EQUAL)) {
        if (translate && !noTranslate && !text.match(/^\s*$/)) {
          let offset = -1;
          const key = text.trim();
          const compiledKey = key.replace(
            PLACEHOLDER_REGEXP_ALL,
            (_, index) => {
              if (offset === -1) offset = Number(index);
              return `\${${Number(index) - offset}}`;
            },
          );

          if (!compiledKey.match(PLACEHOLDER_REGEXP_ONLY)) {
            let context =
              node.previousSibling &&
              node.previousSibling.nodeType === global.Node.COMMENT_NODE
                ? node.previousSibling
                : "";
            if (context) {
              context.parentNode.removeChild(context);
              context = (context.textContent.split("|")[1] || "").trim();
            }

            const value = getMessage(compiledKey, context).replace(
              /\${(\d+)}/g,
              (_, index) => getPlaceholder(Number(index) + offset),
            );
            text = text.replace(key, value);
            node.textContent = text;
          }
        }

        const results = text.match(PLACEHOLDER_REGEXP_ALL);
        if (results) {
          let currentNode = node;
          results
            .reduce(
              (acc, placeholder) => {
                const [before, next] = acc.pop().split(placeholder);
                if (before) acc.push(before);
                acc.push(placeholder);
                if (next) acc.push(next);
                return acc;
              },
              [text],
            )
            .forEach((part, index) => {
              if (index === 0) {
                currentNode.textContent = part;
              } else {
                currentNode = currentNode.parentNode.insertBefore(
                  global.document.createTextNode(part),
                  currentNode.nextSibling,
                );

                compileWalker.currentNode = currentNode;
                compileIndex += 1;
              }

              const equal = currentNode.textContent.match(
                PLACEHOLDER_REGEXP_EQUAL,
              );
              if (equal) {
                currentNode.textContent = "";
                parts[equal[1]] = [compileIndex, resolveValue];
              }
            });
        }
      } else {
        const equal = node.textContent.match(PLACEHOLDER_REGEXP_EQUAL);
        if (equal) {
          node.textContent = "";
          parts[equal[1]] = [compileIndex, resolveValue];
        }
      }
    } else {
      /* istanbul ignore else */ // eslint-disable-next-line no-lonely-if
      if (node.nodeType === global.Node.ELEMENT_NODE) {
        if (
          !noTranslate &&
          (node.getAttribute("translate") === "no" ||
            node.tagName.toLowerCase() === "script" ||
            node.tagName.toLowerCase() === "style")
        ) {
          noTranslate = node;
        }

        /* istanbul ignore else */ // eslint-disable-next-line no-lonely-if
        if (probablyDevMode) {
          const tagName = node.tagName.toLowerCase();
          if (
            tagName.match(/.+-.+/) &&
            !global.customElements.get(tagName) &&
            !notDefinedElements.includes(tagName)
          ) {
            notDefinedElements.push(tagName);
          }
        }

        Array.from(node.attributes).forEach((attr) => {
          const value = attr.value.trim();
          /* istanbul ignore next */
          const name = attr.name;
          const equal = value.match(PLACEHOLDER_REGEXP_EQUAL);
          if (equal) {
            const propertyName = getPropertyName(rawParts[equal[1]]);
            parts[equal[1]] = [
              compileIndex,
              resolveProperty(name, propertyName, isSVG),
            ];
            node.removeAttribute(attr.name);
          } else {
            const results = value.match(PLACEHOLDER_REGEXP_ALL);
            if (results) {
              const partialName = `attr__${name}`;

              results.forEach((placeholder, index) => {
                const [, id] = placeholder.match(PLACEHOLDER_REGEXP_EQUAL);
                let isProp = false;
                parts[id] = [
                  compileIndex,
                  (host, target, attrValue) => {
                    const data = dataMap.get(target, {});
                    data[partialName] = (data[partialName] || value).replace(
                      placeholder,
                      attrValue == null ? "" : attrValue,
                    );

                    if (results.length === 1 || index + 1 === results.length) {
                      isProp =
                        isProp ||
                        (!isSVG &&
                          !(target instanceof global.SVGElement) &&
                          name in target);
                      if (isProp) {
                        target[name] = data[partialName];
                      } else {
                        target.setAttribute(name, data[partialName]);
                      }
                      data[partialName] = undefined;
                    }
                  },
                ];
              });

              attr.value = "";
            }
          }
        });
      }
    }

    compileIndex += 1;
  }

  if (probablyDevMode && notDefinedElements.length) {
    console.warn(
      `Not defined ${notDefinedElements
        .map((e) => `<${e}>`)
        .join(", ")} element${
        notDefinedElements.length > 1 ? "s" : ""
      } found in the template:\n${beautifyTemplateLog(signature, -1)}`,
    );
  }

  return function updateTemplateInstance(host, target, args, styleSheets) {
    const data = dataMap.get(target, { type: "function" });

    if (template !== data.template) {
      if (data.template || target.nodeType !== global.Node.TEXT_NODE) {
        removeTemplate(target);
      }

      data.prevArgs = null;

      const fragment = global.document.importNode(
        applyShadyCSS(template, host.tagName).content,
        true,
      );

      const renderWalker = createWalker(fragment);
      const clonedParts = parts.slice(0);

      let renderIndex = 0;
      let currentPart = clonedParts.shift();

      const markers = [];

      data.template = template;
      data.markers = markers;

      while (renderWalker.nextNode()) {
        const node = renderWalker.currentNode;

        while (currentPart && currentPart[0] === renderIndex) {
          markers.push([node, currentPart[1]]);
          currentPart = clonedParts.shift();
        }

        renderIndex += 1;
      }

      if (target.nodeType === global.Node.TEXT_NODE) {
        data.startNode = fragment.childNodes[0];
        data.endNode = fragment.childNodes[fragment.childNodes.length - 1];

        let previousChild = target;

        let child = fragment.childNodes[0];
        while (child) {
          target.parentNode.insertBefore(child, previousChild.nextSibling);
          previousChild = child;
          child = fragment.childNodes[0];
        }
      } else {
        target.appendChild(fragment);
      }
    }

    const adoptedStyleSheets = target.adoptedStyleSheets;
    if (styleSheets) {
      let isEqual = false;

      styleSheets = styleSheets.map((style) => {
        if (style instanceof global.CSSStyleSheet) return style;

        let styleSheet = styleSheetsMap.get(style);
        if (!styleSheet) {
          styleSheet = new global.CSSStyleSheet();
          styleSheet.replaceSync(style);
          styleSheetsMap.set(style, styleSheet);
        }
        return styleSheet;
      });

      if (styleSheets.length === adoptedStyleSheets.length) {
        isEqual = true;
        for (let i = 0; i < styleSheets.length; i += 1) {
          if (styleSheets[i] !== adoptedStyleSheets[i]) {
            isEqual = false;
            break;
          }
        }
      }

      if (!isEqual) target.adoptedStyleSheets = styleSheets;
    } else if (adoptedStyleSheets && adoptedStyleSheets.length) {
      target.adoptedStyleSheets = [];
    }

    const prevArgs = data.prevArgs;
    data.prevArgs = args;

    for (let index = 0; index < data.markers.length; index += 1) {
      if (prevArgs && prevArgs[index] === args[index]) continue; // eslint-disable-line no-continue
      const [node, marker] = data.markers[index];

      try {
        marker(host, node, args[index], prevArgs && prevArgs[index]);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `Following error was thrown when updating a template expression in ${stringifyElement(
            host,
          )}\n${beautifyTemplateLog(signature, index)}`,
        );
        throw error;
      }
    }

    if (target.nodeType !== global.Node.TEXT_NODE) {
      shadyCSS((shady) => {
        if (host.shadowRoot) {
          if (prevArgs) {
            shady.styleSubtree(host);
          } else {
            shady.styleElement(host);
          }
        }
      });
    }
  };
}
