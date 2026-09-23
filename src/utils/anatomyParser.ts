export interface ParsedState {
  variable: string;
  setter: string;
  defaultValue: string;
  line: number;
  role: string;
}

export interface ParsedEffect {
  dependencies: string[];
  isRunAlways: boolean;
  line: number;
  role: string;
}

export interface ParsedHandler {
  name: string;
  parameters: string[];
  line: number;
  role: string;
}

export interface ParsedImport {
  sources: string[];
  from: string;
  line: number;
}

export interface ReactAnatomy {
  components: {
    name: string;
    props: string[];
    line: number;
  }[];
  states: ParsedState[];
  effects: ParsedEffect[];
  handlers: ParsedHandler[];
  imports: ParsedImport[];
}

export function parseReactAnatomy(code: string): ReactAnatomy {
  const lines = code.split("\n");
  const anatomy: ReactAnatomy = {
    components: [],
    states: [],
    effects: [],
    handlers: [],
    imports: [],
  };

  if (!code) return anatomy;

  // Track if we're inside multiline comments or strings if needed,
  // but standard line-by-line regexes are robust enough for most React templates.
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();

    // Skip comment lines
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
      continue;
    }

    // 1. Detect Imports
    // e.g., import { useState, useEffect } from "react";
    const importMatch = line.match(/^import\s+(?:([\w*{}\s,]+)\s+from\s+)?['"]([^'"]+)['"]/);
    if (importMatch) {
      const importsStr = importMatch[1] || "";
      const from = importMatch[2];
      const sources = importsStr
        .replace(/[{}]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      anatomy.imports.push({
        sources,
        from,
        line: lineNum,
      });
      continue;
    }

    // 2. Detect Component declarations
    // e.g., export default function App() {  OR  const App = () => {
    const compMatch = line.match(/(?:export\s+default\s+)?(?:function|const)\s+([A-Z][a-zA-Z0-9]*)\s*[(=\s]/);
    if (compMatch) {
      const compName = compMatch[1];
      
      // Parse props if destructured on the same line
      let props: string[] = [];
      const propsMatch = line.match(/\{\s*([\w\s,]+)\s*\}/);
      if (propsMatch) {
        props = propsMatch[1].split(",").map(p => p.trim()).filter(p => p.length > 0);
      }

      anatomy.components.push({
        name: compName,
        props,
        line: lineNum,
      });
      continue;
    }

    // 3. Detect useState States
    // e.g., const [activeTab, setActiveTab] = useState<string>("blueprint");
    const stateMatch = line.match(/const\s+\[\s*([\w]+)\s*,\s*([\w]+)\s*\]\s*=\s*useState(?:<[^>]*>)?\s*\(([^)]*)\)/);
    if (stateMatch) {
      const variable = stateMatch[1];
      const setter = stateMatch[2];
      const defaultValue = stateMatch[3].trim() || "undefined";
      
      // Compute human-friendly business role based on naming
      let role = `Holds user interface or data state for '${variable}'.`;
      if (variable.toLowerCase().includes("loading") || variable.toLowerCase().includes("generating")) {
        role = `Tracks background activity state. When true, triggers progress loaders and disables action buttons.`;
      } else if (variable.toLowerCase().includes("error")) {
        role = `Stores runtime or validation issues. Shows system alerts and provides retry paths if present.`;
      } else if (variable.toLowerCase().includes("active") || variable.toLowerCase().includes("selected")) {
        role = `Maintains focus reference of the active item in list grids. Updates components based on user selections.`;
      } else if (variable.toLowerCase().includes("list") || variable.toLowerCase().includes("history") || variable.toLowerCase().includes("project")) {
        role = `Maintains list collection data. Renders repeated row components and updates on additions/deletions.`;
      }

      anatomy.states.push({
        variable,
        setter,
        defaultValue,
        line: lineNum,
        role,
      });
      continue;
    }

    // 4. Detect useEffect hooks
    // e.g., useEffect(() => { ... }, [dep1, dep2]);
    const effectMatch = line.match(/useEffect\s*\(\s*\(\s*\)\s*=>/);
    if (effectMatch) {
      // Find dependencies array on this line or subsequent lines (within 2 lines)
      let deps: string[] = [];
      let isRunAlways = true;
      let checkLine = line;

      // Look up to 3 lines ahead to find the dependency bracket [ ... ]
      for (let offset = 0; offset < 3; offset++) {
        if (i + offset < lines.length) {
          const futureLine = lines[i + offset];
          const depArrayMatch = futureLine.match(/\]\s*\)\s*;?/);
          if (depArrayMatch) {
            const startArray = futureLine.indexOf("[");
            const endArray = futureLine.indexOf("]");
            if (startArray !== -1 && endArray !== -1) {
              const inside = futureLine.substring(startArray + 1, endArray);
              deps = inside.split(",").map(d => d.trim()).filter(d => d.length > 0);
              isRunAlways = false;
            } else if (futureLine.includes("[]")) {
              deps = [];
              isRunAlways = false;
            }
            break;
          }
        }
      }

      let role = "Triggers code when the application finishes drawing (mounting) or dependencies update.";
      if (!isRunAlways && deps.length === 0) {
        role = "Initialization trigger. Executes exactly ONCE when the app first loads in the browser.";
      } else if (deps.length > 0) {
        role = `Reactive synchronization loop. Fires whenever variables [${deps.join(", ")}] change values.`;
      }

      anatomy.effects.push({
        dependencies: deps,
        isRunAlways,
        line: lineNum,
        role,
      });
      continue;
    }

    // 5. Detect Handlers/Functions
    // e.g., const handleGenerate = async (promptText) => {  OR  function handleDelete(id) {
    const handlerMatch = line.match(/(?:const|let)\s+([\w]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
    const fnMatch = line.match(/function\s+([\w]+)\s*\(([^)]*)\)/);

    if (handlerMatch || fnMatch) {
      const match = handlerMatch || fnMatch;
      if (match) {
        const name = match[1];
        const paramsStr = match[2] || "";
        const parameters = paramsStr.split(",").map(p => p.trim().split(":")[0].trim()).filter(p => p.length > 0);

        // Ignore standard internal functions or non-handlers
        if (name.startsWith("use") && name.length > 3 && name[3] === name[3].toUpperCase()) {
          continue; // Custom hook, not basic functional handler
        }

        let role = `Custom helper function carrying out business operations.`;
        const lowerName = name.toLowerCase();
        if (lowerName.includes("generate") || lowerName.includes("vibe")) {
          role = `Core generator interface. Coordinates prompt transmission, reads stream buffers, and parses output files.`;
        } else if (lowerName.includes("save") || lowerName.includes("persist")) {
          role = `Persistence sync handler. Posts current source code and metadata payloads back to local databases.`;
        } else if (lowerName.includes("delete") || lowerName.includes("remove")) {
          role = `Destructive cleanup trigger. Deselects current records and purges matching IDs from persistence layers.`;
        } else if (lowerName.includes("copy")) {
          role = `Clipboard utility interface. Loads active files into browser clipboard and updates temporary visual confirmation flags.`;
        } else if (lowerName.includes("select") || lowerName.includes("load")) {
          role = `Context loading handler. Recovers state registries of selected files and switches active workspaces.`;
        } else if (lowerName.includes("download") || lowerName.includes("export")) {
          role = `Exporter browser interface. Builds binary file Blobs, triggers native downloads, and manages virtual anchor links.`;
        }

        anatomy.handlers.push({
          name,
          parameters,
          line: lineNum,
          role,
        });
      }
    }
  }

  return anatomy;
}
