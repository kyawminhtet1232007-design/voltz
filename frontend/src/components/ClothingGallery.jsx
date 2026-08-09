import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './ClothingGallery.css';

const ClothingGallery = () => {
  const [clothingItems, setClothingItems] = useState([]);
  const [message, setMessage] = useState('');
  const [tryOnResult, setTryOnResult] = useState(null);
  const [tryOnLoading, setTryOnLoading] = useState(false);
  const [activeItemId, setActiveItemId] = useState(null);

  const fetchClothingItems = async () => {
    setMessage('');
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setMessage('Please log in to view your clothing gallery.');
        setClothingItems([]);
        return;
      }
      const response = await axios.get('/api/clothing', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setClothingItems(response.data);
    } catch (error) {
      console.error('Error fetching clothing items:', error.response ? error.response.data : error.message);
      setMessage(error.response?.data?.error || 'Failed to fetch clothing items.');
      setClothingItems([]);
    }
  };

  useEffect(() => {
    fetchClothingItems();
  }, []);

  const handleTryOn = async (clothingItemId) => {
    setTryOnResult(null);
    setMessage('');
    setActiveItemId(clothingItemId);
    setTryOnLoading(true);

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setMessage('Please log in to use the try-on feature.');
        setTryOnLoading(false);
        return;
      }

      const response = await axios.post(
        '/api/try-on',
        { clothingItemId },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setTryOnResult(response.data.renderedImageUrl);
    } catch (error) {
      console.error('Try-on error:', error.response ? error.response.data : error.message);
      setMessage(error.response?.data?.error || 'Failed to generate try-on image. Make sure your profile (height, weight, face photo) is complete.');
    } finally {
      setTryOnLoading(false);
    }
  };

  const closeTryOnModal = () => {
    setTryOnResult(null);
    setActiveItemId(null);
  };

  return (
    <div className="clothing-gallery-container">
      <h2>Your Clothing Gallery</h2>
      {message && <p className="message">{message}</p>}
      {clothingItems.length === 0 ? (
        <p className="no-items">No clothing items uploaded yet. Upload some!</p>
      ) : (
        <div className="clothing-items-grid">
          {clothingItems.map((item) => (
            <div key={item.id} className="clothing-item-card">
              <img src={item.image_url} alt={item.category} className="clothing-image" />
              <div className="item-details">
                <p><strong>Category:</strong> {item.category}</p>
                {item.color && <p><strong>Color:</strong> {item.color}</p>}
                <button
                  onClick={() => handleTryOn(item.id)}
                  className="try-on-button"
                  disabled={tryOnLoading && activeItemId === item.id}
                >
                  {tryOnLoading && activeItemId === item.id ? 'Generating...' : 'Try On'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tryOnResult && (
        <div className="try-on-modal-overlay" onClick={closeTryOnModal}>
          <div className="try-on-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Try-On Result</h3>
            <img src={tryOnResult} alt="AI Try-On Result" className="try-on-result-image" />
            <button onClick={closeTryOnModal} className="close-modal-button">Close</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClothingGallery;

