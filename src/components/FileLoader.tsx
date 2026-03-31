import React, { useCallback } from "react";

interface FileLoaderProps {
  onFileLoaded: (file: File) => void;
  loading: boolean;
}

export const FileLoader: React.FC<FileLoaderProps> = ({
  onFileLoaded,
  loading,
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
        <p>Load an HDF5/NeXus file containing NXEventData</p>
        {loading ? (
          <div className="loading-spinner">
            <div className="spinner" />
            <p>Loading file...</p>
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
          </>
        )}
      </div>
    </div>
  );
};
