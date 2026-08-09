import React, { useState, useRef, useCallback, useEffect } from 'react';
import Webcam from 'react-webcam';
import axios from 'axios';
import './ProfileSetup.css';

const ProfileSetup = () => {
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [faceDataUrl, setFaceDataUrl] = useState(null);
  const [message, setMessage] = useState('');
  const webcamRef = useRef(null);

  useEffect(() => {
    // Fetch existing profile data when component mounts
    const fetchProfile = async () => {
      try {
        const token = localStorage.getItem('token'); // Assuming token is stored in localStorage
        if (!token) {
          setMessage('Please log in to view your profile.');
          return;
        }
        const response = await axios.get('/api/profile', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const { height_cm, weight_kg, face_data_url } = response.data;
        setHeight(height_cm || '');
        setWeight(weight_kg || '');
        setFaceDataUrl(face_data_url || null);
      } catch (error) {
        console.error('Error fetching profile:', error);
        setMessage('Failed to fetch profile data.');
      }
    };
    fetchProfile();
  }, []);

  const capture = useCallback(() => {
    const imageSrc = webcamRef.current.getScreenshot();
    setFaceDataUrl(imageSrc);
  }, [webcamRef]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage('');
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setMessage('Please log in to update your profile.');
        return;
      }

      await axios.put('/api/profile', {
        height_cm: parseInt(height, 10),
        weight_kg: parseInt(weight, 10),
        face_data_url: faceDataUrl, // This would ideally be an S3 URL after upload
      }, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      setMessage('Profile updated successfully!');
    } catch (error) {
      console.error('Error updating profile:', error);
      setMessage('Failed to update profile.');
    }
  };

  return (
    <div className="profile-setup-container">
      <h2>Profile Setup</h2>
      {message && <p className="message">{message}</p>}
      <form onSubmit={handleSubmit} className="profile-form">
        <div className="form-group">
          <label htmlFor="height">Height (cm):</label>
          <input
            type="range"
            id="height"
            min="100"
            max="250"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            className="slider"
          />
          <span>{height} cm</span>
        </div>
        <div className="form-group">
          <label htmlFor="weight">Weight (kg):</label>
          <input
            type="range"
            id="weight"
            min="30"
            max="200"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="slider"
          />
          <span>{weight} kg</span>
        </div>

        <div className="face-scan-section">
          <h3>Face Scan</h3>
          <Webcam
            audio={false}
            ref={webcamRef}
            screenshotFormat="image/jpeg"
            width={320}
            height={240}
            className="webcam-feed"
          />
          <button type="button" onClick={capture} className="capture-button">Capture Photo</button>
          {faceDataUrl && (
            <div className="captured-image">
              <h4>Captured Face:</h4>
              <img src={faceDataUrl} alt="Face Scan" />
            </div>
          )}
        </div>

        <button type="submit" className="save-button">Save Profile</button>
      </form>
    </div>
  );
};

export default ProfileSetup;

