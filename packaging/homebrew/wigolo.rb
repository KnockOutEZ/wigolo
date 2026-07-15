# Homebrew formula for wigolo.
#
# Standard npm-package pattern (std_npm_args). At each release, refresh `url`
# to the new version's canonical npm registry tarball and replace the sha256
# placeholder with the real digest (see packaging/RELEASE-RUNBOOK.md).
#
# node@22 is PINNED on purpose: a floating `node` dependency lets Homebrew's
# node major race ahead of the prebuilt native artifacts wigolo ships, which
# forces slow from-source builds and exposes users to silent runtime-major
# skew. Pin the major, bump it deliberately.
class Wigolo < Formula
  desc "Local-first web intelligence for AI agents: search, fetch, crawl, extract, research"
  homepage "https://wigolo.com"
  url "https://registry.npmjs.org/wigolo/-/wigolo-0.1.43-beta.2.tgz"
  sha256 "PLACEHOLDER_REFRESHED_AT_RELEASE"
  license "AGPL-3.0-only"

  depends_on "node@22"

  # Optional: uncomment once the npm dist-tag is stable to auto-detect new
  # versions on `brew livecheck`.
  # livecheck do
  #   url "https://registry.npmjs.org/wigolo/latest"
  #   regex(/"version":\s*"([^"]+)"/i)
  # end

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      wigolo is local-first and needs no API keys for core work.

      First-use downloads (on demand, not at install time):
        - the embedding model (semantic cache + find_similar)
        - the browser engine (JS-rendered pages)
      Pre-cache both ahead of time with:  wigolo warmup --all

      Health check:
        wigolo doctor

      Wire wigolo into an MCP client (e.g. Claude Code) with its absolute path:
        claude mcp add wigolo -- #{opt_bin}/wigolo

      If you prefer a portable command, this also works:
        claude mcp add wigolo -- $(brew --prefix)/bin/wigolo
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/wigolo --version")
  end
end
