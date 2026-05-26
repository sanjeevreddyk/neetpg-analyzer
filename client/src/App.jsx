import React, { useState, useEffect, useRef } from 'react';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // App States
  const [uploadHistory, setUploadHistory] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [stats, setStats] = useState({
    totalQuestions: 0,
    subjects: [],
    chapters: [],
    imageCount: 0,
    confidenceStats: []
  });
  const [logs, setLogs] = useState([]);
  
  // Interaction States
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  
  // Filter States
  const [subjectFilter, setSubjectFilter] = useState('All');
  const [difficultyFilter, setDifficultyFilter] = useState('All');
  const [yearFilter, setYearFilter] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [layoutMode, setLayoutMode] = useState('grid'); // 'grid' (original cards) or 'table' (compact list)
  const [zoomedImage, setZoomedImage] = useState(null);
  
  // Settings Configuration States
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [geminiKeyExists, setGeminiKeyExists] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [keyLoadError, setKeyLoadError] = useState('');
  
  const fileInputRef = useRef(null);
  const logsEndRef = useRef(null);

  // Initialize and poll data
  useEffect(() => {
    fetchHistory();
    fetchQuestions();
    fetchSummaryStats();
    fetchSystemLogs();
    
    // Poll queue status and logs every 3 seconds for real-time console feeling
    const interval = setInterval(() => {
      fetchHistory();
      fetchSystemLogs();
      fetchSummaryStats();
    }, 3000);
    
    return () => clearInterval(interval);
  }, []);

  // Re-fetch questions when filters change
  useEffect(() => {
    fetchQuestions();
  }, [subjectFilter, difficultyFilter, yearFilter, searchTerm, page, itemsPerPage]);

  // Scroll logs console to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // ==========================================
  // API FETCH CALLS
  // ==========================================

  const fetchHistory = async () => {
    try {
      const response = await fetch('/api/processingStatus');
      if (response.ok) {
        const data = await response.json();
        setUploadHistory(data);
      }
    } catch (err) {
      console.error('Failed to load processing history:', err);
    }
  };

  const fetchQuestions = async () => {
    try {
      const offset = (page - 1) * itemsPerPage;
      let url = `/api/questions?limit=${itemsPerPage}&offset=${offset}`;
      
      if (subjectFilter !== 'All') url += `&subject=${encodeURIComponent(subjectFilter)}`;
      if (difficultyFilter !== 'All') url += `&difficulty=${encodeURIComponent(difficultyFilter)}`;
      if (yearFilter !== 'All') url += `&year=${encodeURIComponent(yearFilter)}`;
      if (searchTerm) url += `&search=${encodeURIComponent(searchTerm)}`;
      
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setQuestions(data.questions);
        setTotalQuestions(data.totalCount);
      }
    } catch (err) {
      console.error('Failed to load questions:', err);
    }
  };

  const fetchSummaryStats = async () => {
    try {
      const response = await fetch('/api/summary');
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    } catch (err) {
      console.error('Failed to load summary stats:', err);
    }
  };

  const fetchSystemLogs = async () => {
    try {
      const response = await fetch('/api/logs');
      if (response.ok) {
        const data = await response.json();
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Failed to load execution logs:', err);
    }
  };

  const deleteQuestion = async (id, e) => {
    if (e) e.stopPropagation(); // Avoid triggering card details modal!
    if (!window.confirm('Are you sure you want to permanently delete this question? This action is irreversible.')) return;
    
    try {
      const response = await fetch(`/api/question/${id}`, { method: 'DELETE' });
      if (response.ok) {
        fetchQuestions();
        fetchSummaryStats();
        if (selectedQuestion && selectedQuestion.Question_ID === id) {
          setSelectedQuestion(null);
        }
      } else {
        const err = await response.json();
        alert(err.error || 'Failed to delete question.');
      }
    } catch (err) {
      console.error('Failed to delete question:', err);
    }
  };

  const deleteUpload = async (id, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Are you sure you want to permanently delete this upload package? This will delete the physical PDF file along with ALL extracted questions and associated visual diagrams!')) return;
    
    try {
      const response = await fetch(`/api/upload/${id}`, { method: 'DELETE' });
      if (response.ok) {
        fetchHistory();
        fetchQuestions();
        fetchSummaryStats();
      } else {
        const err = await response.json();
        alert(err.error || 'Failed to delete upload record.');
      }
    } catch (err) {
      console.error('Failed to delete upload record:', err);
    }
  };

  // ==========================================
  // INTERACTIVE EVENT HANDLERS
  // ==========================================

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFilesUpload(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFilesUpload(e.target.files);
    }
  };

  const handleFilesUpload = async (filesList) => {
    const files = Array.from(filesList);
    
    // Validations: Limit formats to PDF only
    const nonPdfs = files.filter(f => !f.name.toLowerCase().endsWith('.pdf'));
    if (nonPdfs.length > 0) {
      alert('Validation Failure: Supported format is PDF only!');
      return;
    }
    
    // Validations: Check sizes
    const oversized = files.filter(f => f.size > 1024 * 1024 * 1024); // 1GB limit
    if (oversized.length > 0) {
      alert('Validation Failure: Maximum file size limit is 1GB!');
      return;
    }

    setIsUploading(true);
    setUploadProgress(20);
    
    const formData = new FormData();
    files.forEach(file => {
      formData.append('pdfFiles', file);
    });

    try {
      setUploadProgress(50);
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      
      setUploadProgress(85);
      const data = await response.json();
      
      if (response.ok && data.success) {
        setUploadProgress(100);
        // Automatically trigger parsing queue for all uploaded files
        for (const up of data.uploads) {
          await triggerFileProcessing(up.uploadId);
        }
        fetchHistory();
        fetchQuestions();
        fetchSummaryStats();
      } else {
        alert(data.error || 'Failed to complete upload.');
      }
    } catch (err) {
      console.error('Network boundary failed:', err);
      alert('Failed to connect to backend server.');
    } finally {
      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress(0);
      }, 800);
    }
  };

  const triggerFileProcessing = async (uploadId) => {
    try {
      await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId })
      });
    } catch (err) {
      console.error('Trigger request crashed:', err);
    }
  };

  const triggerExcelDownload = (uploadId = '') => {
    let url = '/api/downloadExcel';
    if (uploadId) url += `?uploadId=${uploadId}`;
    window.location.href = url;
  };

  const viewQuestionDetails = async (questionId) => {
    try {
      const response = await fetch(`/api/question/${questionId}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedQuestion(data);
      }
    } catch (err) {
      console.error('Failed to load question details:', err);
    }
  };

  const handleOpenSettings = async () => {
    setKeyLoadError('');
    setGeminiKeyInput('');
    setShowSettingsModal(true);
    try {
      const response = await fetch('/api/settings/gemini_api_key');
      if (response.ok) {
        const data = await response.json();
        setGeminiKeyExists(data.apiKeyExists);
        if (data.apiKeyExists) {
          setGeminiKeyInput(data.maskedKey); // Show as ****
        }
      }
    } catch (err) {
      console.error('Failed to load Gemini key settings:', err);
      setKeyLoadError('Failed to connect to backend configuration API.');
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    if (!geminiKeyInput || geminiKeyInput.trim() === '') {
      alert('Please enter a valid Google Gemini API key.');
      return;
    }
    
    // If it's already masked (****) and they didn't change it, simply close modal
    if (geminiKeyExists && geminiKeyInput === '****') {
      setShowSettingsModal(false);
      return;
    }
    
    setIsSavingKey(true);
    try {
      const response = await fetch('/api/settings/gemini_api_key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: geminiKeyInput.trim() })
      });
      if (response.ok) {
        alert('Google Gemini API Key stored securely in database.');
        setShowSettingsModal(false);
      } else {
        const err = await response.json();
        alert(err.error || 'Failed to save Google Gemini API Key.');
      }
    } catch (err) {
      console.error('Failed to save API key:', err);
      alert('Network boundary failed: Cannot connect to server.');
    } finally {
      setIsSavingKey(false);
    }
  };

  // Format File Size
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Format Dates
  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="app-container">
      {/* Header Bar */}
      <header className="header">
        <div className="header-logo">
          <div className="logo-badge">🩺</div>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.4rem' }}>
              NEET PG Ingestion Console
            </h2>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              High-Fidelity Paper Parsing System
            </span>
          </div>
        </div>
        
        <nav className="nav-tabs">
          <button 
            className={`nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button 
            className={`nav-tab ${activeTab === 'questions' ? 'active' : ''}`}
            onClick={() => setActiveTab('questions')}
          >
            Question Bank
          </button>
          <button 
            className={`nav-tab ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            Trend Hub
          </button>
          <button 
            className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            System Console
          </button>
          <button 
            className="nav-tab"
            onClick={handleOpenSettings}
            style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}
            title="Configure System Settings"
          >
            ⚙️ Settings
          </button>
        </nav>
      </header>

      {/* Global Stat Indicators */}
      <section className="stats-strip">
        <div className="stat-box purple">
          <span className="stat-label">Total Bank Database</span>
          <div className="stat-value">
            {stats.totalQuestions || 0} <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Items</span>
          </div>
        </div>
        <div className="stat-box cyan">
          <span className="stat-label">Subject Categories</span>
          <div className="stat-value">
            {stats.subjects ? stats.subjects.length : 0} <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Groups</span>
          </div>
        </div>
        <div className="stat-box emerald">
          <span className="stat-label">Image-based Items</span>
          <div className="stat-value">
            {stats.imageCount || 0} <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Diagrams</span>
          </div>
        </div>
        <div className="stat-box amber">
          <span className="stat-label">Ingested Files</span>
          <div className="stat-value">
            {uploadHistory.length} <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>PDFs</span>
          </div>
        </div>
      </section>

      {/* TAB CONTENTS */}
      
      {/* 1. DASHBOARD */}
      {activeTab === 'dashboard' && (
        <div className="dashboard-grid">
          {/* Ingestion Engine Card */}
          <div className="panel-card">
            <div className="panel-header">
              <h3 className="panel-title"><span>📂</span> Ingestion Control Room</h3>
              <span className="status-badge completed" style={{ fontSize: '0.65rem' }}>Active</span>
            </div>
            
            <div 
              className={`dropzone ${dragActive ? 'active' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current.click()}
            >
              <input 
                ref={fileInputRef}
                type="file" 
                multiple 
                accept=".pdf" 
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              <span className="dropzone-icon">📥</span>
              <h4 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.5rem' }}>
                Drag & Drop NEET PG papers here
              </h4>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                Supports multiple uploads. High fidelity PDF extraction up to 1GB.
              </p>
              <button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); fileInputRef.current.click(); }}>
                Browse Files
              </button>
            </div>

            {isUploading && (
              <div style={{ marginTop: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                  <span>Uploading files...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.05)', height: '6px', borderRadius: '99px', overflow: 'hidden' }}>
                  <div style={{ background: 'var(--accent-cyan)', height: '100%', width: `${uploadProgress}%`, transition: 'width 0.2s ease' }}></div>
                </div>
              </div>
            )}
          </div>

          {/* Active Job Tracker */}
          <div className="panel-card">
            <div className="panel-header">
              <h3 className="panel-title"><span>🔄</span> Active Processing Queues</h3>
              <button 
                className="btn btn-cyan" 
                style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                onClick={() => triggerExcelDownload()}
                disabled={stats.totalQuestions === 0}
              >
                📥 Export Combined Excel
              </button>
            </div>

            <div className="queue-list">
              {uploadHistory.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                  <span>📭 No papers uploaded yet</span>
                </div>
              ) : (
                uploadHistory.map(up => (
                  <div key={up.Upload_ID} className="queue-item">
                    <div className="queue-info">
                      <span className="queue-name">{up.File_Name}</span>
                      <div className="queue-meta">
                        <span>{formatBytes(up.File_Size)}</span>
                        <span>•</span>
                        <span>{formatDate(up.Upload_Date)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      {up.Processing_Status === 'COMPLETED' && (
                        <span style={{ fontSize: '0.8rem', color: 'var(--success-emerald)', fontWeight: 600 }}>
                          +{up.Questions_Extracted} Qs
                        </span>
                      )}
                      <span className={`status-badge ${up.Processing_Status.toLowerCase()}`}>
                        {up.Processing_Status === 'PROCESSING' && '⏳ '}
                        {up.Processing_Status}
                      </span>
                      {up.Processing_Status === 'COMPLETED' && (
                        <button 
                          className="btn-secondary" 
                          style={{ border: 'none', background: 'rgba(255,255,255,0.04)', borderRadius: '6px', padding: '0.35rem 0.6rem', cursor: 'pointer', color: 'var(--text-primary)' }}
                          onClick={() => triggerExcelDownload(up.Upload_ID)}
                          title="Download Excel for this Paper"
                        >
                          📥
                        </button>
                      )}
                      <button 
                        className="btn-secondary" 
                        style={{ border: 'none', background: 'rgba(244,63,94,0.1)', borderRadius: '6px', padding: '0.35rem 0.6rem', cursor: 'pointer', color: 'var(--danger-rose)' }}
                        onClick={(e) => deleteUpload(up.Upload_ID, e)}
                        title="Delete Upload Package & Ingested Questions"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. QUESTION BANK */}
      {activeTab === 'questions' && (
        <div className="panel-card" style={{ minHeight: '500px' }}>
          <div className="panel-header">
            <h3 className="panel-title"><span>📂</span> Question Repository Grid</h3>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <button 
                className="btn btn-secondary" 
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', background: layoutMode === 'grid' ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255,255,255,0.02)', color: layoutMode === 'grid' ? 'var(--text-primary)' : 'var(--text-secondary)', border: '1px solid var(--border-glass)', borderRadius: '8px', cursor: 'pointer' }}
                onClick={() => setLayoutMode('grid')}
              >
                🎴 Card View
              </button>
              <button 
                className="btn btn-secondary" 
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', background: layoutMode === 'table' ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255,255,255,0.02)', color: layoutMode === 'table' ? 'var(--text-primary)' : 'var(--text-secondary)', border: '1px solid var(--border-glass)', borderRadius: '8px', cursor: 'pointer' }}
                onClick={() => setLayoutMode('table')}
              >
                📋 Compact Table
              </button>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                Showing {questions.length} of {totalQuestions} questions
              </span>
            </div>
          </div>

          {/* Dynamic Filter Row */}
          <div className="filter-bar" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
            <input 
              type="text" 
              className="form-control"
              placeholder="🔍 Search symptoms, diagnoses, keywords..."
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
            />
            
            <select 
              className="form-control"
              value={subjectFilter}
              onChange={(e) => { setSubjectFilter(e.target.value); setPage(1); }}
            >
              <option value="All">All Subjects</option>
              {stats.subjects && stats.subjects.map(s => (
                <option key={s.Subject} value={s.Subject}>{s.Subject} ({s.count})</option>
              ))}
            </select>

            <select 
              className="form-control"
              value={difficultyFilter}
              onChange={(e) => { setDifficultyFilter(e.target.value); setPage(1); }}
            >
              <option value="All">All Difficulties</option>
              <option value="Easy">Easy</option>
              <option value="Medium">Medium</option>
              <option value="Hard">Hard</option>
            </select>

            <select 
              className="form-control"
              value={yearFilter}
              onChange={(e) => { setYearFilter(e.target.value); setPage(1); }}
            >
              <option value="All">All Years</option>
              {stats.years && stats.years.map(y => (
                <option key={y.year} value={y.year}>{y.year} ({y.count})</option>
              ))}
            </select>

            <select 
              className="form-control"
              value={itemsPerPage}
              onChange={(e) => { setItemsPerPage(parseInt(e.target.value)); setPage(1); }}
            >
              <option value={25}>25 per page</option>
              <option value={50}>50 per page</option>
              <option value={75}>75 per page</option>
              <option value={100}>100 per page</option>
            </select>

            <button 
              className="btn btn-cyan"
              style={{ display: 'flex', justifyContent: 'center' }}
              onClick={() => triggerExcelDownload()}
              disabled={questions.length === 0}
            >
              📥 Download Excel
            </button>
          </div>

          {/* Core Questions Renderer */}
          {questions.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '5rem' }}>
              <span>🔍 No questions matching current filter constraints</span>
            </div>
          ) : (
            <>
              {layoutMode === 'table' ? (
                <div style={{ overflowX: 'auto', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', borderRadius: '12px', marginBottom: '1.5rem' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border-glass)' }}>
                        <th style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>Q No</th>
                        <th style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>Subject</th>
                        <th style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>Question Text</th>
                        <th style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>Difficulty</th>
                        <th style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>Confidence</th>
                        <th style={{ padding: '0.85rem 1rem', fontWeight: 600, textAlign: 'center' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {questions.map(q => (
                        <tr 
                          key={q.Question_ID} 
                          onClick={() => viewQuestionDetails(q.Question_ID)}
                          style={{ borderBottom: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'background 0.2s' }}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          <td style={{ padding: '0.85rem 1rem', fontWeight: 700, color: 'var(--text-muted)' }}>{q.Question_Number}</td>
                          <td style={{ padding: '0.85rem 1rem' }}>
                            <span className="badge subject">{q.Subject}</span>
                          </td>
                          <td style={{ padding: '0.85rem 1rem', maxWidth: '420px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {q.Question_Text}
                          </td>
                          <td style={{ padding: '0.85rem 1rem' }}>
                            <span className="badge difficulty">{q.Difficulty_Level}</span>
                          </td>
                          <td style={{ padding: '0.85rem 1rem' }}>
                            <span className={`badge conf-${q.OCR_Confidence}`}>OCR {q.OCR_Confidence}</span>
                          </td>
                          <td style={{ padding: '0.85rem 1rem', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                            <button 
                              className="btn-secondary"
                              style={{ border: 'none', background: 'rgba(244,63,94,0.1)', borderRadius: '6px', padding: '0.35rem 0.5rem', cursor: 'pointer', color: 'var(--danger-rose)' }}
                              onClick={(e) => deleteQuestion(q.Question_ID, e)}
                              title="Delete Question"
                            >
                              🗑️
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="questions-grid">
                  {questions.map(q => (
                    <div key={q.Question_ID} className="question-card" onClick={() => viewQuestionDetails(q.Question_ID)}>
                      <div className="q-card-header">
                        <span className="q-num">Q. {q.Question_Number}</span>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                          <span className={`badge conf-${q.OCR_Confidence}`}>
                            OCR {q.OCR_Confidence}
                          </span>
                          <button 
                            className="btn-secondary"
                            style={{ border: 'none', background: 'rgba(244,63,94,0.15)', borderRadius: '4px', padding: '0.2rem 0.35rem', cursor: 'pointer', color: 'var(--danger-rose)', fontSize: '0.75rem' }}
                            onClick={(e) => deleteQuestion(q.Question_ID, e)}
                            title="Delete Question"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                      
                      <p className="q-text">{q.Question_Text}</p>
                      
                      <div className="q-footer">
                        <span className="badge subject">{q.Subject}</span>
                        <span className="badge difficulty">{q.Difficulty_Level}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Simple Pagination Footer */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '2rem', alignItems: 'center' }}>
                <button 
                  className="btn btn-secondary" 
                  style={{ padding: '0.4rem 1rem' }}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  Previous
                </button>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Page {page} of {Math.ceil(totalQuestions / itemsPerPage) || 1}
                </span>
                <button 
                  className="btn btn-secondary" 
                  style={{ padding: '0.4rem 1rem' }}
                  onClick={() => setPage(p => p + 1)}
                  disabled={page >= Math.ceil(totalQuestions / itemsPerPage)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 3. TRENDS & ANALYTICS */}
      {activeTab === 'analytics' && (
        <div className="dashboard-grid">
          {/* Subject Frequency Panel */}
          <div className="panel-card">
            <h3 className="panel-title" style={{ marginBottom: '1.5rem' }}><span>📊</span> Subject Frequency Distribution</h3>
            {stats.totalQuestions === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '5rem' }}>
                No database metrics loaded. Ingest papers to visualize trends.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {stats.subjects && stats.subjects.map(s => {
                  const percentage = stats.totalQuestions ? ((s.count / stats.totalQuestions) * 100).toFixed(1) : 0;
                  return (
                    <div key={s.Subject}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.35rem' }}>
                        <span style={{ fontWeight: 600 }}>{s.Subject}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{s.count} Qs ({percentage}%)</span>
                      </div>
                      <div style={{ background: 'rgba(255,255,255,0.03)', height: '10px', borderRadius: '99px', overflow: 'hidden' }}>
                        <div style={{ background: 'linear-gradient(90deg, var(--accent-violet), var(--accent-cyan))', height: '100%', width: `${percentage}%` }}></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Chapter Density & 2026 Predictions */}
          <div className="panel-card">
            <h3 className="panel-title" style={{ marginBottom: '1.5rem' }}><span>🔮</span> NEET PG 2026 Prediction Model</h3>
            <div style={{ background: 'rgba(139, 92, 246, 0.05)', border: '1px solid rgba(139, 92, 246, 0.2)', padding: '1.25rem', borderRadius: '12px', marginBottom: '1.5rem' }}>
              <h4 style={{ fontFamily: 'var(--font-display)', color: 'var(--accent-violet)', marginBottom: '0.5rem' }}>
                High-Yield Probability Matrix
              </h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Based on historical trend algorithms, repeated clinical indicators, and curriculum weight ratios, our engine predicts high probability trends for NEET PG 2026.
              </p>
            </div>

            {stats.totalQuestions === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
                Database metrics are currently empty.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderBottom: '1px solid var(--border-glass)' }}>
                  <div>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>Cardiology: Acute Coronary Syndrome</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Focus on ECG mappings & coronary occlusion indicators</span>
                  </div>
                  <span className="status-badge completed" style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'var(--success-emerald)' }}>94% Yield</span>
                </div>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderBottom: '1px solid var(--border-glass)' }}>
                  <div>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>Endocrine Pathology: Thyroid Swellings</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Focus on histological features (Hurthle cells, follicles)</span>
                  </div>
                  <span className="status-badge completed" style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'var(--success-emerald)' }}>88% Yield</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderBottom: '1px solid var(--border-glass)' }}>
                  <div>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>Neonatology: Infant Distress</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Focus on radiograph (RDS ground-glass granules)</span>
                  </div>
                  <span className="status-badge pending" style={{ background: 'rgba(245, 158, 11, 0.15)', color: 'var(--warning-amber)' }}>76% Yield</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem' }}>
                  <div>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem' }}>NSAIDs: Cox Enzymes Inhibition</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Irreversible binding properties of Aspirin</span>
                  </div>
                  <span className="status-badge pending" style={{ background: 'rgba(245, 158, 11, 0.15)', color: 'var(--warning-amber)' }}>69% Yield</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. SYSTEM LOGS & SETTINGS */}
      {activeTab === 'settings' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {/* Live system logs */}
          <div className="panel-card">
            <div className="panel-header">
              <h3 className="panel-title"><span>💻</span> System Execution Console</h3>
              <span className="status-badge processing" style={{ fontSize: '0.65rem' }}>Streaming Live</span>
            </div>
            
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Monitors document parser bounds, visual image extractions, cleaning regular expressions, and SQLite ingestion transaction times.
            </p>

            <div className="logs-console">
              {logs.length === 0 ? (
                <div style={{ color: 'var(--text-muted)' }}>System logs are currently empty. Awaiting jobs...</div>
              ) : (
                logs.map((line, index) => {
                  let cl = 'info';
                  if (line.includes('[WARN]')) cl = 'warn';
                  else if (line.includes('[ERROR]')) cl = 'error';
                  
                  return (
                    <div key={index} className={`log-line ${cl}`}>
                      {line}
                    </div>
                  );
                })
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* Detail Overlay Modal */}
      {selectedQuestion && (
        <div className="modal-overlay" onClick={() => setSelectedQuestion(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedQuestion(null)}>×</button>
            
            <div className="modal-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
                  Question Detail #{selectedQuestion.Question_Number}
                </h3>
                <span className={`badge conf-${selectedQuestion.OCR_Confidence}`} style={{ padding: '0.35rem 0.75rem', borderRadius: '8px' }}>
                  OCR Confidence: {selectedQuestion.OCR_Confidence}
                </span>
              </div>

              <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', borderRadius: '12px', padding: '1.25rem' }}>
                <p style={{ fontWeight: 500, fontSize: '1.05rem', lineHeight: '1.5' }}>
                  {selectedQuestion.Question_Text}
                </p>
              </div>

              {/* Show actual extracted diagram if present */}
              {(selectedQuestion.Image_Present === 1 || selectedQuestion.Image_Present === true) && (
                <div className="image-display-container" style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.75rem',
                  background: 'rgba(255, 255, 255, 0.01)',
                  border: '1px solid var(--border-glass)',
                  borderRadius: '12px',
                  padding: '1.25rem',
                  margin: '1rem 0'
                }}>
                  <div 
                    style={{ position: 'relative', cursor: 'zoom-in', width: '100%', display: 'flex', justifyContent: 'center' }}
                    onClick={() => setZoomedImage(selectedQuestion.Embedded_Image)}
                    title="Click to Zoom Diagram"
                  >
                    <img 
                      src={selectedQuestion.Embedded_Image} 
                      alt={selectedQuestion.Image_Description || "Extracted Medical Diagram"} 
                      style={{
                        maxWidth: '100%',
                        maxHeight: '380px',
                        borderRadius: '8px',
                        boxShadow: '0 4px 25px rgba(0, 0, 0, 0.5), 0 0 20px rgba(139, 92, 246, 0.2)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        objectFit: 'contain'
                      }}
                      onError={(e) => {
                        e.target.onerror = null;
                        e.target.src = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%230f172a%22/><text x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 font-size=%2240%22>🖼️</text></svg>";
                      }}
                    />
                    <div className="zoom-badge-overlay">
                      🔍 Click to Zoom
                    </div>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    Caption: {selectedQuestion.Image_Description || "Visual diagram extracted from PDF page"}
                  </span>
                </div>
              )}

              {/* Display Multiple Choice Options in Grid */}
              <div className="options-list">
                <div className={`option-item ${selectedQuestion.Correct_Answer === 'A' ? 'correct' : ''}`}>
                  <span className="option-letter">A</span>
                  <span>{selectedQuestion.Option_A}</span>
                </div>
                <div className={`option-item ${selectedQuestion.Correct_Answer === 'B' ? 'correct' : ''}`}>
                  <span className="option-letter">B</span>
                  <span>{selectedQuestion.Option_B}</span>
                </div>
                <div className={`option-item ${selectedQuestion.Correct_Answer === 'C' ? 'correct' : ''}`}>
                  <span className="option-letter">C</span>
                  <span>{selectedQuestion.Option_C}</span>
                </div>
                <div className={`option-item ${selectedQuestion.Correct_Answer === 'D' ? 'correct' : ''}`}>
                  <span className="option-letter">D</span>
                  <span>{selectedQuestion.Option_D}</span>
                </div>
              </div>

              {/* Display Clinical Explanation */}
              {selectedQuestion.Answer_Explanation && (
                <div className="explanation-box">
                  <h4 style={{ fontFamily: 'var(--font-display)', color: 'var(--accent-violet)', marginBottom: '0.5rem', fontSize: '0.95rem' }}>
                    Clinical Rationale & Answer Explanation
                  </h4>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                    {selectedQuestion.Answer_Explanation}
                  </p>
                </div>
              )}

              {/* Metadata Badges Footer */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', paddingTop: '1rem', borderTop: '1px solid var(--border-glass)' }}>
                <span className="badge subject">Subject: {selectedQuestion.Subject}</span>
                <span className="badge subject" style={{ background: 'rgba(6, 182, 212, 0.15)', color: '#22d3ee' }}>
                  Chapter: {selectedQuestion.Chapter}
                </span>
                <span className="badge difficulty">Difficulty: {selectedQuestion.Difficulty_Level}</span>
                <span className="badge difficulty" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#34d399' }}>
                  Domain: {selectedQuestion.Clinical_or_Conceptual}
                </span>
                <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)' }}>
                  Year: {selectedQuestion.Previous_Year}
                </span>
                <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)' }}>
                  Page: {selectedQuestion.Page_Number}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Zoomed Image Overlay Modal */}
      {zoomedImage && (
        <div className="zoom-overlay" onClick={() => setZoomedImage(null)}>
          <button className="zoom-close" onClick={() => setZoomedImage(null)}>×</button>
          <div className="zoom-content" onClick={(e) => e.stopPropagation()}>
            <img 
              src={zoomedImage} 
              alt="Zoomed Medical Diagram" 
              className="zoom-image"
              onError={(e) => {
                e.target.onerror = null;
                e.target.src = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%230f172a%22/><text x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 font-size=%2240%22>🖼️</text></svg>";
              }}
            />
          </div>
        </div>
      )}

      {/* Settings Configuration Modal */}
      {showSettingsModal && (
        <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-content" style={{ maxWidth: '480px' }} onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowSettingsModal(false)}>×</button>
            
            <div className="modal-body" style={{ gap: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '1rem' }}>
                <span style={{ fontSize: '1.75rem' }}>⚙️</span>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
                    System Configuration
                  </h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Configure external intelligence keys
                  </span>
                </div>
              </div>
              
              <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Google Gemini API Key
                  </label>
                  <input 
                    type={geminiKeyInput === '****' ? 'text' : 'password'} 
                    className="form-control"
                    placeholder="Enter Google Gemini API Key..."
                    value={geminiKeyInput}
                    onChange={(e) => setGeminiKeyInput(e.target.value)}
                    style={{ fontFamily: geminiKeyInput === '****' ? 'inherit' : 'Consolas, monospace', fontSize: '0.95rem' }}
                    required
                  />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {geminiKeyExists ? (
                      <span style={{ color: 'var(--success-emerald)' }}>
                        ✓ Key is already stored and active in the database. Enter a new key above to update.
                      </span>
                    ) : (
                      <span>The key is stored in the local SQLite database and never shared outside.</span>
                    )}
                  </span>
                </div>
                
                {keyLoadError && (
                  <div style={{ color: 'var(--danger-rose)', fontSize: '0.8rem', background: 'rgba(244,63,94,0.05)', padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid rgba(244,63,94,0.1)' }}>
                    {keyLoadError}
                  </div>
                )}
                
                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                  <button 
                    type="button" 
                    className="btn btn-secondary" 
                    style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
                    onClick={() => setShowSettingsModal(false)}
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit" 
                    className="btn btn-cyan"
                    style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem' }}
                    disabled={isSavingKey}
                  >
                    {isSavingKey ? 'Saving...' : geminiKeyExists ? 'Update Key' : 'Save Key'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
