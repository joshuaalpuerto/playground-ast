import * as fs from "node:fs";
import * as path from "node:path";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";

// first we will try to check if ImportDefaultSpecifier or  ImportSpecifier existing from the source.value
// then check the source.value if the dependency can be resolve as `VariableDeclaration` otherwise we will check ExportSpecifier then we have to walk through it.
module.exports = async function (fileInfo, api) {
  if (fileInfo.path.endsWith("index.js")) return;

  const AST = api.jscodeshift;
  const root = AST(fileInfo.source);

  // find all import declartions
  return root
    .find(AST.ImportDeclaration, {
      source: {
        type: "Literal",
        value: "./barrel",
      },
    })
    .replaceWith((nodePath) => {
      const modulePath = nodePath.node.source.value;

      const paths = nodePath.node.specifiers.map((specifier) => {
        const importedName = specifier.imported.name;
        const mapping = getDependencyLocation(
          {
            importedName: importedName,
            localName: specifier.local.name,
            filePath: fileInfo.path,
            modulePath,
          },
          api
        );
        const isDefault =
          mapping.type.name === AST.ExportDefaultDeclaration.name;

        return AST.importDeclaration(
          isDefault
            ? [AST.importDefaultSpecifier(AST.identifier(mapping.importedName))]
            : [
                AST.importSpecifier(
                  AST.identifier(mapping.importedName),
                  AST.identifier(mapping.localName)
                ),
              ],
          AST.literal(mapping.filePath)
        );
      });

      return paths;
    })
    .toSource({ quote: "single" });
};

function getDependencyLocation(mappings, api) {
  const j = api.jscodeshift;
  const currentFile = getFile(mappings.filePath, mappings.modulePath);

  const code = fs.readFileSync(currentFile, "utf-8");
  const ast = parser.parse(code, {
    sourceType: "module",
  });

  traverse(ast, {
    ExportDefaultDeclaration(nodePath) {
      const node = nodePath.node;
      if (node.declaration.name === mappings.importedName) {
        mappings.type = j.ExportDefaultDeclaration;
        mappings.filePath = currentFile;
      }
    },
    ExportNamedDeclaration(nodePath) {
      const node = nodePath.node;
      // on barrell files there could be multiple imports
      // we have to find which file is the import we are evaluating.
      const isImportFromThisExport = node.specifiers.find(
        (specifier) => specifier.exported.name === mappings.importedName
      );
      // if this is bareel, go deeper
      if (isImportFromThisExport) {
        // update the filePath
        mappings.filePath = currentFile;
        mappings.type = j.ExportNamedDeclaration;
        mappings.modulePath = `${node.source.value}.js`;
        getDependencyLocation(mappings, api);
      } else {
        // check if we already walk to the actual file
        if (node.declaration?.type === j.VariableDeclaration.name) {
          const declarations = node.declaration.declarations;
          const findDeclaration = declarations.find(
            (declaration) => declaration.id.name === mappings.importedName
          );

          if (findDeclaration) {
            mappings.type = j.ExportNamedDeclaration;
            mappings.filePath = currentFile;
          }
        }
      }
    },
  });

  return mappings;
}

function getFile(currentPathEvaluated, modulePath) {
  const absolutePath = path.resolve(
    path.dirname(currentPathEvaluated),
    modulePath
  );

  if (fs.existsSync(absolutePath)) {
    const currentFileStat = fs.statSync(absolutePath);

    // TODO: we assume that all folders will have index.js
    const walkableFile = currentFileStat.isDirectory()
      ? path.join(absolutePath, "index.js")
      : absolutePath;

    return walkableFile;
  }

  return false;
}
