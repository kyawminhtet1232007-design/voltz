import React, { useState } from 'react';
import axios from 'axios';
import './Auth.css';

const Auth = ({ onLoginSuccess }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage('');
    const url = isRegister ? '/api/register' : '/api/login';

    try {
      const response = await axios.post(url, { email, password });
      setMessage(response.data.message);
      if (response.data.token) {
        localStorage.setItem('token', response.data.token);
        onLoginSuccess(); // Notify parent component of successful login
      }
    } catch (error) {
      console.error('Auth error:', error.response ? error.response.data : error.message);
      setMessage(error.response?.data?.error || 'Authentication failed.');
    }
  };

  return (
    <div className="auth-container">
      <h2>{isRegister ? 'Register' : 'Login'}</h2>
      {message && <p className="message">{message}</p>}
      <form onSubmit={handleSubmit} className="auth-form">
        <div className="form-group">
          <label htmlFor="email">Email:</label>
          <input
            type="email"
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="password">Password:</label>
          <input
            type="password"
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="auth-button">
          {isRegister ? 'Register' : 'Login'}
        </button>
      </form>
      <p className="toggle-auth">
        {isRegister ? 'Already have an account?' : 'Don\'t have an account?'}
        <button type="button" onClick={() => setIsRegister(!isRegister)} className="toggle-button">
          {isRegister ? 'Login' : 'Register'}
        </button>
      </p>
    </div>
  );
};

export default Auth;

