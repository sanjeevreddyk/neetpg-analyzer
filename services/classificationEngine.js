/**
 * NEET PG Question Classification Engine (Module 3)
 * Automatically classifies Subject, Chapter, Topic, Difficulty, and Question Type
 * using lexical patterns, keyword dictionaries, and clinical heuristics.
 */

// Subject and Chapter mappings
const MEDICAL_SUBJECTS = {
  "Medicine": {
    keywords: ["ecg", "chest pain", "coronary", "heart failure", "infarction", "diabetes", "hypertension", "stroke", "meningitis", "asthma", "pneumonia"],
    chapters: {
      "Cardiology": ["ecg", "chest pain", "coronary", "infarction", "heart failure"],
      "Neurology": ["stroke", "meningitis", "seizure", "neuropathy", "headache"],
      "Endocrinology": ["diabetes", "thyroid", "adrenal", "pituitary"],
      "Pulmonology": ["asthma", "pneumonia", "copd", "pleural effusion"]
    }
  },
  "Pathology": {
    keywords: ["histology", "biopsy", "microscopy", "cells", "follicles", "pathology", "lymphocyte", "leukemia", "lymphoma", "adenoma", "carcinoma"],
    chapters: {
      "Neoplasia": ["carcinoma", "adenoma", "leukemia", "lymphoma", "tumor"],
      "Hematology": ["lymphocyte", "leukemia", "lymphoma", "anemia"],
      "Endocrine Pathology": ["thyroiditis", "biopsy", "follicles"]
    }
  },
  "Pharmacology": {
    keywords: ["drug", "inhibits", "receptor", "agonist", "antagonist", "aspirin", "ibuprofen", "pharmacology", "toxicity", "mechanism"],
    chapters: {
      "Autonomic Nervous System": ["agonist", "antagonist", "receptor", "acetylcholine"],
      "NSAIDs & Rheumatology": ["aspirin", "ibuprofen", "cox-1", "cox-2", "nsaid"],
      "Chemotherapy": ["antibiotic", "antineoplastic", "inhibitor"]
    }
  },
  "Pediatrics": {
    keywords: ["child", "infant", "newborn", "premature", "pediatric", "grunting", "pediatrics", "developmental", "growth"],
    chapters: {
      "Neonatology": ["newborn", "premature", "grunting", "rds", "surfactant"],
      "Pediatric Hematology": ["lymphoblast", "all", "child", "progressive fatigue"]
    }
  },
  "Anatomy": {
    keywords: ["anatomical", "muscle", "artery", "nerve", "chiasm", "lobe", "cortex", "medulla", "vein", "anatomy"],
    chapters: {
      "Neuroanatomy": ["chiasm", "cortex", "optic chiasm", "pituitary macro-adenoma"],
      "Gross Anatomy": ["artery", "nerve", "muscle", "vein"]
    }
  }
};

/**
 * Classifies an extracted question text
 * @param {string} text The cleaned question content
 * @returns {object} Object containing classified subject, chapter, topic, difficulty, clinical category, question type, and keywords
 */
function classifyQuestion(text) {
  const lowercaseText = text.toLowerCase();
  
  let classifiedSubject = "Medicine";
  let classifiedChapter = "Medicine Principles";
  let classifiedTopic = "General Medical Review";
  let matchedKeywords = [];
  
  // 1. Determine Subject & Chapter
  let subjectFound = false;
  for (const [subjectName, subjectData] of Object.entries(MEDICAL_SUBJECTS)) {
    // Check main subject keywords
    const matches = subjectData.keywords.filter(kw => lowercaseText.includes(kw));
    if (matches.length > 0) {
      classifiedSubject = subjectName;
      matchedKeywords = matchedKeywords.concat(matches);
      
      // Determine Chapter
      for (const [chapterName, chapterKeywords] of Object.entries(subjectData.chapters)) {
        const chapterMatches = chapterKeywords.filter(ckw => lowercaseText.includes(ckw));
        if (chapterMatches.length > 0) {
          classifiedChapter = chapterName;
          classifiedTopic = `Clinical ${chapterName} Topic`;
          break;
        }
      }
      subjectFound = true;
      break;
    }
  }
  
  // 2. Identify Difficulty Level
  // Clinical scenarios are generally Hard/Medium; simple facts are Easy
  let difficulty = "Medium";
  const clinicalKeywords = ["presents with", "history of", "physical exam", "biopsy", "shows", "radiograph", "biopsy is taken", "year-old"];
  const clinicalMatches = clinicalKeywords.filter(kw => lowercaseText.includes(kw));
  
  if (clinicalMatches.length >= 3) {
    difficulty = "Hard";
  } else if (clinicalMatches.length > 0) {
    difficulty = "Medium";
  } else {
    difficulty = "Easy";
  }
  
  // 3. Classify Cognitive Types & Question Types
  let clinicalOrConceptual = "Conceptual";
  let questionType = "Single Best Answer";
  
  if (clinicalMatches.length > 0) {
    clinicalOrConceptual = "Clinical Scenario";
    questionType = "Clinical Scenario";
  } else if (lowercaseText.includes("assertion") || lowercaseText.includes("reason")) {
    clinicalOrConceptual = "Conceptual";
    questionType = "Assertion Reason";
  } else if (lowercaseText.includes("identify") || lowercaseText.includes("shown in the image") || lowercaseText.includes("radiograph")) {
    clinicalOrConceptual = "Clinical Scenario";
    questionType = "Image Based";
  } else {
    clinicalOrConceptual = "Fact Recall";
    questionType = "Fact Recall";
  }
  
  // Return classified payload
  return {
    subject: classifiedSubject,
    chapter: classifiedChapter,
    topic: classifiedTopic,
    difficulty: difficulty,
    clinicalType: clinicalOrConceptual,
    questionType: questionType,
    keywords: matchedKeywords.length > 0 ? [...new Set(matchedKeywords)] : ["general"]
  };
}

module.exports = {
  classifyQuestion
};
