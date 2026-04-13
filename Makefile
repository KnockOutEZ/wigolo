.PHONY: help release-patch release-minor release-major release-dry-run

# Disable gpg signing just for these targets (project rule: never sign)
NOSIGN := GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=tag.gpgsign GIT_CONFIG_VALUE_0=false \
  GIT_CONFIG_KEY_1=commit.gpgsign GIT_CONFIG_VALUE_1=false

help:  ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

release-patch:  ## Bump patch, tag, push (fires release workflow)
	$(NOSIGN) npm version patch
	git push --follow-tags

release-minor:  ## Bump minor, tag, push (fires release workflow)
	$(NOSIGN) npm version minor
	git push --follow-tags

release-major:  ## Bump major, tag, push (fires release workflow)
	$(NOSIGN) npm version major
	git push --follow-tags

release-dry-run:  ## Build and preview npm tarball (no publish, no tag)
	rm -rf dist
	npm run build
	npm publish --dry-run
