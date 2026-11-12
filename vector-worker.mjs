import { exportFlatSVG, exportSceneSVG } from "./flat-export.mjs";
self.onmessage = ({ data }) => {
  try {
    const progress = (progress) => self.postMessage({ progress });
    self.postMessage({
      result: data.flags
        ? exportSceneSVG(data.flags, data.options, progress)
        : exportFlatSVG(data.cloth, data.options, data.source, progress),
    });
  } catch (e) {
    self.postMessage({ error: e.message });
  }
};
