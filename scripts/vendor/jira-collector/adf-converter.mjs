function textContent(node, state) {
  return (node?.content || []).map((child) => render(child, state)).join("");
}

function recordUrl(url, state, source = "adf") {
  if (url) state.links.push({url, source});
  return url || "";
}

function renderTableRow(node, state) {
  const cells = (node.content || []).map((cell) => textContent(cell, state).trim().replaceAll("|", "\\|"));
  return `| ${cells.join(" | ")} |\n`;
}

function render(node, state) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "doc": return textContent(node, state).trimEnd();
    case "paragraph": return `${textContent(node, state)}\n\n`;
    case "heading": return `${"#".repeat(Math.min(6, Math.max(1, node.attrs?.level || 1)))} ${textContent(node, state)}\n\n`;
    case "text": {
      let value = node.text || "";
      for (const mark of node.marks || []) {
        if (mark.type === "strong") value = `**${value}**`;
        else if (mark.type === "em") value = `_${value}_`;
        else if (mark.type === "code") value = `\`${value}\``;
        else if (mark.type === "strike") value = `~~${value}~~`;
        else if (mark.type === "link") value = `[${value}](${recordUrl(mark.attrs?.href, state)})`;
      }
      return value;
    }
    case "hardBreak": return "\n";
    case "rule": return "\n---\n\n";
    case "codeBlock": return `\`\`\`${node.attrs?.language || ""}\n${(node.content || []).map((child) => child.text || "").join("")}\n\`\`\`\n\n`;
    case "blockquote": return `${textContent(node, state).trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "bulletList": return (node.content || []).map((item) => `- ${textContent(item, state).trim()}\n`).join("") + "\n";
    case "orderedList": return (node.content || []).map((item, index) => `${(node.attrs?.order || 1) + index}. ${textContent(item, state).trim()}\n`).join("") + "\n";
    case "listItem": return textContent(node, state);
    case "table": {
      const rows = node.content || [];
      if (!rows.length) return "";
      const rendered = rows.map((row) => renderTableRow(row, state));
      const width = Math.max(1, rows[0].content?.length || 1);
      return `${rendered[0]}| ${Array(width).fill("---").join(" | ")} |\n${rendered.slice(1).join("")}\n`;
    }
    case "tableRow": return renderTableRow(node, state);
    case "tableHeader":
    case "tableCell": return textContent(node, state);
    case "mention": return `@${node.attrs?.text || node.attrs?.displayName || node.attrs?.id || "unknown"}`;
    case "inlineCard":
    case "blockCard": return recordUrl(node.attrs?.url, state, node.type);
    case "mediaSingle": return textContent(node, state);
    case "media": {
      const ref = {id: node.attrs?.id || "", collection: node.attrs?.collection || "", url: node.attrs?.url || ""};
      state.mediaRefs.push(ref);
      if (ref.url) return `![media](${recordUrl(ref.url, state, "media")})`;
      return `![media:${ref.id || "unknown"}]`;
    }
    default:
      state.unsupportedNodes.add(node.type || "unknown");
      return textContent(node, state);
  }
}

export function convertAdf(value) {
  if (value == null) return {markdown: "", links: [], media_refs: [], unsupported_nodes: []};
  if (typeof value === "string") return {markdown: value, links: [], media_refs: [], unsupported_nodes: []};
  const state = {links: [], mediaRefs: [], unsupportedNodes: new Set()};
  return {markdown: render(value, state).trim(), links: state.links, media_refs: state.mediaRefs, unsupported_nodes: [...state.unsupportedNodes].sort()};
}
