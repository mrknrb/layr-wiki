// Page types: what kind of thing a page is about (`type:` in its properties). A type gives the info box its fields and
// labels, and a new page its starting properties and sections. The built-in ones are for a biology PhD; the user (or
// the AI, with wiki__define_type) can add more or change these, kept as plugin data `type/<name>`. A page may have any
// type, also one that isn't defined: its info box then shows all its properties as they are.
//
// Field kinds: text (the default), link (`"[[Page]]"`), links (a list of them), list (of words), date (YYYY-MM-DD),
// number, url, and id fields with `url` (a pattern with {} for the value: a stable link to a public database).

export const BUILT_IN_TYPES = [
  {
    name: "Gene",
    icon: "🧬",
    fields: [
      { key: "symbol", label: "Symbol" },
      { key: "full_name", label: "Full name" },
      { key: "organism", label: "Organism", kind: "link" },
      { key: "protein", label: "Protein", kind: "link" },
      { key: "chromosome", label: "Chromosome" },
      { key: "ncbi_gene", label: "NCBI Gene", url: "https://www.ncbi.nlm.nih.gov/gene/{}" },
      { key: "ensembl", label: "Ensembl", url: "https://www.ensembl.org/id/{}" },
    ],
    sections: ["Function", "Regulation", "Interactions", "In my research", "Sources"],
  },
  {
    name: "Protein",
    icon: "🔷",
    fields: [
      { key: "gene", label: "Gene", kind: "link" },
      { key: "organism", label: "Organism", kind: "link" },
      { key: "uniprot", label: "UniProt", url: "https://www.uniprot.org/uniprotkb/{}/entry" },
      { key: "pdb", label: "PDB", url: "https://www.rcsb.org/structure/{}" },
      { key: "length_aa", label: "Length (aa)", kind: "number" },
      { key: "localization", label: "Localization", kind: "list" },
      { key: "domains", label: "Domains", kind: "list" },
    ],
    sections: ["Function", "Structure", "Modifications", "Interactions", "In my research", "Sources"],
  },
  {
    name: "Pathway",
    icon: "🔀",
    fields: [
      { key: "organism", label: "Organism", kind: "link" },
      { key: "key_players", label: "Key players", kind: "links" },
      { key: "kegg", label: "KEGG", url: "https://www.kegg.jp/entry/{}" },
      { key: "reactome", label: "Reactome", url: "https://reactome.org/content/detail/{}" },
    ],
    sections: ["Overview", "Steps", "Regulation", "Crosstalk", "In my research", "Sources"],
  },
  {
    name: "Organism",
    icon: "🦠",
    fields: [
      { key: "scientific_name", label: "Scientific name" },
      { key: "common_name", label: "Common name" },
      { key: "strain", label: "Strain" },
      {
        key: "taxon_id",
        label: "NCBI Taxonomy",
        url: "https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id={}",
      },
    ],
    sections: ["Overview", "As a model organism", "Handling and culture", "Sources"],
  },
  {
    name: "Method",
    icon: "🧪",
    fields: [
      { key: "category", label: "Category" },
      { key: "duration", label: "Duration" },
      { key: "equipment", label: "Equipment", kind: "list" },
      { key: "reagents", label: "Reagents", kind: "links" },
      { key: "source", label: "Source" },
    ],
    sections: ["Principle", "Materials", "Protocol", "Notes and pitfalls", "Sources"],
  },
  {
    name: "Paper",
    icon: "📄",
    fields: [
      { key: "authors", label: "Authors", kind: "list" },
      { key: "year", label: "Year", kind: "number" },
      { key: "journal", label: "Journal" },
      { key: "doi", label: "DOI", url: "https://doi.org/{}" },
      { key: "pmid", label: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/{}/" },
      { key: "citekey", label: "Cite key" },
      { key: "status", label: "Status", options: ["to read", "reading", "read"] },
    ],
    sections: ["Summary", "Key claims", "Methods", "Relevance to my work", "Open questions"],
  },
  {
    name: "Experiment",
    icon: "🔬",
    fields: [
      { key: "date", label: "Date", kind: "date" },
      { key: "status", label: "Status", options: ["planned", "running", "done", "failed"] },
      { key: "hypothesis", label: "Hypothesis", kind: "link" },
      { key: "methods", label: "Methods", kind: "links" },
      { key: "samples", label: "Samples", kind: "list" },
    ],
    sections: ["Aim", "Setup", "Deviations", "Results", "Conclusion", "Next steps"],
  },
  {
    name: "Reagent",
    icon: "🧴",
    fields: [
      { key: "kind", label: "Kind", options: ["antibody", "plasmid", "cell line", "primer", "chemical", "kit", "other"] },
      { key: "supplier", label: "Supplier" },
      { key: "catalog", label: "Catalog no." },
      { key: "lot", label: "Lot" },
      { key: "location", label: "Location" },
      { key: "concentration", label: "Concentration" },
    ],
    sections: ["Use", "Working conditions", "Validation", "Notes"],
  },
  {
    name: "Person",
    icon: "👤",
    fields: [
      { key: "role", label: "Role" },
      { key: "affiliation", label: "Affiliation" },
      { key: "email", label: "Email" },
      { key: "orcid", label: "ORCID", url: "https://orcid.org/{}" },
    ],
    sections: ["Work", "Collaboration", "Notes"],
  },
  {
    name: "Hypothesis",
    icon: "💡",
    fields: [
      { key: "status", label: "Status", options: ["open", "supported", "refuted"] },
      { key: "confidence", label: "Confidence", options: ["low", "medium", "high"] },
      { key: "evidence_for", label: "Evidence for", kind: "links" },
      { key: "evidence_against", label: "Evidence against", kind: "links" },
    ],
    sections: ["Statement", "Reasoning", "Evidence", "How to test it"],
  },
  {
    name: "Topic",
    icon: "📚",
    fields: [],
    sections: ["Overview", "Key pages", "Open questions"],
  },
  { name: "Note", icon: "🗒️", fields: [], sections: [] },
];

/** Built-in types with the user's own (`[{name, ...}]` from plugin data) on top, by name (any case). */
export function mergeTypes(custom = []) {
  const byKey = new Map(BUILT_IN_TYPES.map((t) => [t.name.toLowerCase(), { ...t, builtIn: true }]));
  for (const t of custom) {
    if (!t?.name) continue;
    const key = String(t.name).toLowerCase();
    const base = byKey.get(key);
    byKey.set(key, { ...(base ?? { icon: "📄", fields: [], sections: [] }), ...t, builtIn: Boolean(base) });
  }
  return [...byKey.values()];
}

/** The type of this name (any case) from `types`, or null. */
export const findType = (types, name) =>
  name ? types.find((t) => t.name.toLowerCase() === String(name).toLowerCase()) ?? null : null;

/** A new page's Markdown for `type`: its type, empty fields, and its sections as headings. */
export function templateFor(type, { stringify }) {
  if (!type) return "";
  const props = { type: type.name };
  for (const f of type.fields ?? []) props[f.key] = f.kind === "links" || f.kind === "list" ? [] : null;
  const yaml = stringify(props);
  const body = (type.sections ?? []).map((s) => `## ${s}\n\n`).join("");
  return `---\n${yaml}\n---\n\n${body}`.replace(/\n+$/, "\n");
}
