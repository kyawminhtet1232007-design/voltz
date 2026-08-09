import React, { useState, useEffect } from 'react';
import ProfileSetup from './components/ProfileSetup.jsx';
import ClothingUpload from './components/ClothingUpload.jsx'; // Import ClothingUpload
import ClothingGallery from './components/ClothingGallery.jsx'; // Import ClothingGallery
import Auth from './components/Auth.jsx';
import './App.css';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [key, setKey] = useState(0); // Key to force remount/re-fetch for ClothingGallery

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      setIsAuthenticated(true);
    }
  }, []);

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
    setKey(prevKey => prevKey + 1); // Force ClothingGallery to re-render
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setIsAuthenticated(false);
    setKey(prevKey => prevKey + 1); // Reset key on logout
  };

  const handleUploadSuccess = () => {
    setKey(prevKey => prevKey + 1); // Increment key to force ClothingGallery to re-fetch
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>AI Try-On App</h1>
        {isAuthenticated && (
          <button onClick={handleLogout} className="logout-button">Logout</button>
        )}
      </header>
      <main>
        {isAuthenticated ? (
          <>
            <ProfileSetup />
            <ClothingUpload onUploadSuccess={handleUploadSuccess} />
            <ClothingGallery key={key} /> {/* Use key to force re-render */}
          </>
        ) : (
          <Auth onLoginSuccess={handleLoginSuccess} />
        )}
      </main>
    </div>
  );
}

export default App;