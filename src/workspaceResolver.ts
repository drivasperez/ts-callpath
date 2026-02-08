import * as fs from 'fs';
import * as path from 'path';

/**
 * Maps @watershed/* package specifiers to filesystem paths.
 * Built once at startup by scanning workspaces/STAR/package.json.
 */
export class WorkspaceResolver {
  /** package name (e.g. "@watershed/domain") → directory (absolute) */
  private packageDirs: Map<string, string> = new Map();

  constructor(private repoRoot: string) {
    this.buildPackageMap();
  }

  private buildPackageMap(): void {
    const workspacesDir = path.join(this.repoRoot, 'workspaces');
    if (!fs.existsSync(workspacesDir)) return;

    const entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = path.join(workspacesDir, entry.name, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (pkgJson.name) {
          this.packageDirs.set(
            pkgJson.name,
            path.join(workspacesDir, entry.name)
          );
        }
      } catch {
        // skip malformed package.json
      }
    }
  }

  /**
   * Resolve a package specifier like "@watershed/domain/service/BartService"
   * to an absolute file path.
   * Returns null if not resolvable.
   */
  resolve(specifier: string): string | null {
    // Find the matching package prefix
    // Try progressively shorter prefixes: @watershed/domain/service → @watershed/domain
    const parts = specifier.split('/');
    // @watershed packages always have scope + name, so minimum 2 parts
    if (parts.length < 2) return null;

    // Try @scope/name first (most common)
    const pkgName = `${parts[0]}/${parts[1]}`;
    const pkgDir = this.packageDirs.get(pkgName);
    if (!pkgDir) return null;

    const subpath = parts.slice(2).join('/');
    if (!subpath) {
      // Importing the package root — look for index file
      return this.resolveFile(path.join(pkgDir, 'index'));
    }

    return this.resolveFile(path.join(pkgDir, subpath));
  }

  /**
   * Try to resolve a base path to an actual file by appending common extensions.
   */
  private resolveFile(basePath: string): string | null {
    // If already has extension and exists
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      return basePath;
    }

    const extensions = ['.ts', '.tsx', '.js', '.jsx'];
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (fs.existsSync(candidate)) return candidate;
    }

    // Try index files in directory
    for (const ext of extensions) {
      const candidate = path.join(basePath, 'index' + ext);
      if (fs.existsSync(candidate)) return candidate;
    }

    return null;
  }

  getPackageDirs(): Map<string, string> {
    return this.packageDirs;
  }
}
