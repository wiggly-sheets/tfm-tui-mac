// --- System optional dependencies checking and automated installation ---
// Packages: ImageMagick (magick/convert), fd (fd/fdfind), ffmpeg (ffmpeg),
// 7-Zip (7z/7za), ripgrep (rg).
// Supported package managers: macOS brew, Linux apt, pacman, dnf, zypper, apk, brew.

export type SystemPkgId =
  | "imagemagick"
  | "fd"
  | "ffmpeg"
  | "7zip"
  | "ripgrep"
  | "git"
  | "gio"
  | "zip"
  | "unzip"
  | "tag";

export type SystemPkgSpec = {
  id: SystemPkgId;
  name: string;
  blurb: string;
  // Binary names to check via which (first found wins)
  bins: string[];
  // Package names per package manager (key = pkg manager id)
  pkgs: Partial<Record<PkgManagerId, string>>;
};

export type PkgManagerId = "brew" | "apt" | "pacman" | "dnf" | "zypper" | "apk";

export type PkgManagerSpec = {
  id: PkgManagerId;
  name: string;
  checkBin: string;
  installCmd: (pkgs: string[]) => { bin: string; args: string[]; sudo: boolean };
};

export const OPTIONAL_PACKAGES: SystemPkgSpec[] = [
  {
    id: "imagemagick",
    name: "ImageMagick",
    blurb: "Image thumbnails & previews",
    bins: ["magick", "convert"],
    pkgs: {
      brew: "imagemagick",
      apt: "imagemagick",
      pacman: "imagemagick",
      dnf: "ImageMagick",
      zypper: "ImageMagick",
      apk: "imagemagick",
    },
  },
  {
    id: "fd",
    name: "fd",
    blurb: "Fast directory search",
    bins: ["fd", "fdfind"],
    pkgs: {
      brew: "fd",
      apt: "fd-find",
      pacman: "fd",
      dnf: "fd-find",
      zypper: "fd",
      apk: "fd",
    },
  },
  {
    id: "ffmpeg",
    name: "ffmpeg",
    blurb: "Video thumbnail generation",
    bins: ["ffmpeg"],
    pkgs: {
      brew: "ffmpeg",
      apt: "ffmpeg",
      pacman: "ffmpeg",
      dnf: "ffmpeg",
      zypper: "ffmpeg",
      apk: "ffmpeg",
    },
  },
  {
    id: "7zip",
    name: "7-Zip",
    blurb: "Archive compression & extraction",
    bins: ["7z", "7za", "7zr", "7zz"],
    pkgs: {
      brew: "sevenzip",
      apt: "p7zip-full",
      pacman: "p7zip",
      dnf: "p7zip",
      zypper: "p7zip",
      apk: "p7zip",
    },
  },
  {
    id: "ripgrep",
    name: "ripgrep",
    blurb: "Fast text search in files",
    bins: ["rg"],
    pkgs: {
      brew: "ripgrep",
      apt: "ripgrep",
      pacman: "ripgrep",
      dnf: "ripgrep",
      zypper: "ripgrep",
      apk: "ripgrep",
    },
  },
  {
    id: "git",
    name: "git",
    blurb: "Plugin installs & updates",
    bins: ["git"],
    pkgs: {
      brew: "git",
      apt: "git",
      pacman: "git",
      dnf: "git",
      zypper: "git",
      apk: "git",
    },
  },
  {
    id: "gio",
    name: "gio (GLib)",
    blurb: "Network mount (gvfs) on Linux",
    bins: ["gio"],
    pkgs: {
      brew: "glib",
      apt: "libglib2.0-bin",
      pacman: "glib",
      dnf: "glib2",
      zypper: "glib2",
      apk: "glib",
    },
  },
  {
    id: "zip",
    name: "zip",
    blurb: "Archive creation",
    bins: ["zip"],
    pkgs: {
      brew: "zip",
      apt: "zip",
      pacman: "zip",
      dnf: "zip",
      zypper: "zip",
      apk: "zip",
    },
  },
  {
    id: "unzip",
    name: "unzip",
    blurb: "Archive extraction",
    bins: ["unzip"],
    pkgs: {
      brew: "unzip",
      apt: "unzip",
      pacman: "unzip",
      dnf: "unzip",
      zypper: "unzip",
      apk: "unzip",
    },
  },
  {
    id: "tag",
    name: "tag (Finder tags)",
    blurb: "Finder tag sync (macOS only)",
    bins: ["tag"],
    pkgs: {
      brew: "tag",
    },
  },
];

export const PACKAGE_MANAGERS: PkgManagerSpec[] = [
  {
    id: "brew",
    name: "Homebrew",
    checkBin: "brew",
    installCmd: (pkgs) => ({ bin: "brew", args: ["install", ...pkgs], sudo: false }),
  },
  {
    id: "apt",
    name: "APT",
    checkBin: "apt-get",
    installCmd: (pkgs) => ({ bin: "apt-get", args: ["install", "-y", ...pkgs], sudo: true }),
  },
  {
    id: "pacman",
    name: "Pacman",
    checkBin: "pacman",
    installCmd: (pkgs) => ({ bin: "pacman", args: ["-S", "--noconfirm", ...pkgs], sudo: true }),
  },
  {
    id: "dnf",
    name: "DNF",
    checkBin: "dnf",
    installCmd: (pkgs) => ({ bin: "dnf", args: ["install", "-y", ...pkgs], sudo: true }),
  },
  {
    id: "zypper",
    name: "Zypper",
    checkBin: "zypper",
    installCmd: (pkgs) => ({ bin: "zypper", args: ["install", "-n", ...pkgs], sudo: true }),
  },
  {
    id: "apk",
    name: "APK",
    checkBin: "apk",
    installCmd: (pkgs) => ({ bin: "apk", args: ["add", ...pkgs], sudo: true }),
  },
];

export type WhichFn = (bin: string) => string | null;

export const detectPkgManager = (
  which: WhichFn = Bun.which,
  platform: string = process.platform,
): PkgManagerSpec | null => {
  if (platform === "darwin") {
    return which("brew") ? (PACKAGE_MANAGERS.find((m) => m.id === "brew") ?? null) : null;
  }
  // Linux (or other unix): test in order
  for (const pm of PACKAGE_MANAGERS) {
    if (which(pm.checkBin)) return pm;
  }
  return null;
};

export type PkgStatus = {
  spec: SystemPkgSpec;
  installed: boolean;
  foundBin: string | null;
  pkgName: string | null;
};

export const checkPkgStatus = (
  pkg: SystemPkgSpec,
  pm: PkgManagerSpec | null,
  which: WhichFn = Bun.which,
): PkgStatus => {
  let foundBin: string | null = null;
  for (const b of pkg.bins) {
    if (which(b)) {
      foundBin = b;
      break;
    }
  }
  const pkgName = pm ? (pkg.pkgs[pm.id] ?? pkg.id) : pkg.id;
  return {
    spec: pkg,
    installed: foundBin !== null,
    foundBin,
    pkgName,
  };
};

export const checkAllPkgs = (
  which: WhichFn = Bun.which,
  platform: string = process.platform,
): { pm: PkgManagerSpec | null; statuses: PkgStatus[] } => {
  const pm = detectPkgManager(which, platform);
  const statuses = OPTIONAL_PACKAGES.map((pkg) => checkPkgStatus(pkg, pm, which));
  return { pm, statuses };
};

export type InstallPlan = {
  pm: PkgManagerSpec;
  pkgsToInstall: string[];
  bin: string;
  args: string[];
  sudo: boolean;
};

export const makeInstallPlan = (
  targets: string[],
  which: WhichFn = Bun.which,
  platform: string = process.platform,
): InstallPlan => {
  const pm = detectPkgManager(which, platform);
  if (!pm) {
    throw new Error("No supported package manager found (brew, apt, pacman, dnf, zypper, apk)");
  }

  const pkgsToInstall: string[] = [];
  const validIdsOrBins = new Set<string>();
  for (const p of OPTIONAL_PACKAGES) {
    validIdsOrBins.add(p.id);
    for (const b of p.bins) validIdsOrBins.add(b);
  }

  // If no specific targets provided or "all", select all missing packages
  const normTargets = targets.map((t) => t.toLowerCase());
  const pickAll = normTargets.length === 0 || normTargets.includes("all");

  for (const pkg of OPTIONAL_PACKAGES) {
    const isTargeted = pickAll || normTargets.includes(pkg.id) || pkg.bins.some((b) => normTargets.includes(b));

    if (isTargeted) {
      const pkgName = pkg.pkgs[pm.id];
      if (pkgName) pkgsToInstall.push(pkgName);
    }
  }

  if (normTargets.length > 0 && !pickAll) {
    for (const t of normTargets) {
      if (!validIdsOrBins.has(t)) {
        throw new Error(
          `Unknown optional tool or binary: "${t}". Known tools: ${OPTIONAL_PACKAGES.map((p) => p.id).join(", ")}`,
        );
      }
    }
  }

  if (pkgsToInstall.length === 0) {
    throw new Error("No packages to install");
  }

  const cmd = pm.installCmd(pkgsToInstall);
  return {
    pm,
    pkgsToInstall,
    bin: cmd.bin,
    args: cmd.args,
    sudo: cmd.sudo,
  };
};
