module.exports = {
  hooks: {
    beforePacking(manifest) {
      if (manifest.name === 'cortico-world-parlor') {
        // The checkout also builds and tests the gateway. The World tarball
        // only ships the single-room command and has no development tooling.
        manifest.scripts = { serve: manifest.scripts.serve };
        delete manifest.devDependencies;
      }
      return manifest;
    },
  },
};
