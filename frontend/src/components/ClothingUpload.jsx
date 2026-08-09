import React, { useState } from 'react';
import axios from 'axios';
import './ClothingUpload.css';

const ClothingUpload = ({ onUploadSuccess }) => {
  const [selectedFile, setSelectedFile] = useState(null);
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [message, setMessage] = useState('');

  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMessage('');

    if (!selectedFile) {
      setMessage('Please select a file to upload.');
      return;
    }

    const formData = new FormData();
    formData.append('clothingImage', selectedFile);
    formData.append('category', category);
    formData.append('color', color);

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setMessage('Please log in to upload clothing.');
        return;
      }

      const response = await axios.post('/api/upload/clothing', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${token}`,
        },
      });
      setMessage(response.data.message);
      setSelectedFile(null);
      setCategory('');
      setColor('');
      if (onUploadSuccess) {
        onUploadSuccess(); // Notify parent to refresh gallery
      }
    } catch (error) {
      console.error('Error uploading clothing:', error.response ? error.response.data : error.message);
      setMessage(error.response?.data?.error || 'Failed to upload clothing.');
    }
  };

  return (
    <div className="clothing-upload-container">
      <h2>Upload New Clothing Item</h2>
      {message && <p className="message">{message}</p>}
      <form onSubmit={handleSubmit} className="clothing-upload-form">
        <div className="form-group">
          <label htmlFor="file-upload">Choose Image:</label>
          <input
            type="file"
            id="file-upload"
            accept="image/*"
            onChange={handleFileChange}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="category">Category:</label>
          <input
            type="text"
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g., shirt, pants, dress"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="color">Color:</label>
          <input
            type="text"
            id="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="e.g., blue, red, black"
          />
        </div>
        <button type="submit" className="upload-button">Upload Clothing</button>
      </form>
    </div>
  );
};

export default ClothingUpload;
