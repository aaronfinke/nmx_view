import React, { useCallback } from "react";

interface FileLoaderProps {
  onFileLoaded: (file: File) => void;
  onLoadDemo?: () => void;
  loading: boolean;
  progress?: number;
  progressLabel?: string;
}

export const FileLoader: React.FC<FileLoaderProps> = ({
  onFileLoaded,
  onLoadDemo,
  loading,
  progress = 0,
  progressLabel = "",
}) => {
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) onFileLoaded(file);
    },
    [onFileLoaded]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileLoaded(file);
    },
    [onFileLoaded]
  );

  return (
    <div
      className="file-loader"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className="file-loader-content">
        <h2>NMX Event Data Viewer</h2>
        <p>A Web-based app for viewing NeXus event data, with TOF slicing and analysis tools.</p>
        <p>Load an HDF5/NeXus file containing <a href="https://manual.nexusformat.org/classes/base_classes/NXevent_data.html">NXevent_data</a>.<br />
         Pre-binned <a href="https://manual.nexusformat.org/classes/applications/NXlauetof.html#nxlauetof">NXLaueTOF</a> files are also supported.</p>
        <p>All processing happens locally in the browser with <a href="https://h5web.panosc.eu">h5web</a>:<br /> 
          no remote loading of data!</p>
        <p>Use <a href="https://myhdf5.hdfgroup.org">myHDF5</a> if you need a web-based app for viewing HDF5 data without advanced TOF visualization.</p>
        {loading ? (
          <div className="loading-progress">
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
            <p className="progress-label">{progressLabel || "Loading file..."}</p>
            <p className="progress-percent">{Math.round(progress)}%</p>
          </div>
        ) : (
          <>
            <div className="drop-zone">
              <p>Drag & drop an HDF5 file here</p>
              <p>or</p>
              <label className="file-input-label">
                Browse files
                <input
                  type="file"
                  accept=".h5,.hdf5,.nxs,.nx5,.nxspe"
                  onChange={handleFileInput}
                  hidden
                />
              </label>
            </div>
            {onLoadDemo && (
              <p className="demo-hint">
                No data of your own?{" "}
                <button type="button" className="demo-link-btn" onClick={onLoadDemo}>
                  Load a demo dataset
                </button>
              </p>
            )}
          </>
        )}
        <p className="github-link">
          <a href="https://github.com/aaronfinke/nmx_view" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </p>
      </div>
    </div>
    
  );
};
