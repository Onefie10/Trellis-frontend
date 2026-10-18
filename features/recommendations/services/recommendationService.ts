import { RecommendedAgent, FeedbackData } from '../types';
import { getUserVector } from '../utils/userVectorStore';
import { extractTextVector, cosineSimilarity } from '../utils/similarity';

export const recommendationService = {
  getRecommendations: async (): Promise<RecommendedAgent[]> => {
    try {
      return new Promise((resolve) => {
        setTimeout(() => {
          const allAgents: RecommendedAgent[] = [
            {
              id: 'agent-1',
              name: 'Nebula Analytica',
              description: 'AI-driven data analysis for complex datasets.',
              explanation: 'Based on your interest in data visualization and analytics.',
              topFeatures: ['High-performance processing', 'Interactive dashboards', 'Multi-cloud integration'],
              rating: 4.8,
              users: 1540,
            },
            {
              id: 'agent-2',
              name: 'Canopy Writer',
              description: 'Generates creative content with a stellar twist.',
              explanation: 'Matches your frequent use of content generation tools and Creative skill tag.',
              topFeatures: ['Brand-aware content', 'Multi-language support', 'Image-to-text integration'],
              rating: 4.7,
              users: 980,
            },
            {
              id: 'agent-3',
              name: 'Starship Navigator',
              description: 'Pathfinding and logistics optimization for space travel.',
              explanation: 'Highly relevant to your projects in logistics.',
              topFeatures: ['Real-time obstacle avoidance', 'Fuel efficiency analysis', 'Auto-docking system'],
              rating: 4.9,
              users: 210,
            },
            {
              id: 'agent-4',
              name: 'Code Weaver',
              description: 'Automated code review and programming assistant.',
              explanation: 'Matches your development and coding activity.',
              topFeatures: ['Syntax checking', 'Refactoring suggestions', 'Test generation'],
              rating: 4.6,
              users: 3200,
            },
            {
              id: 'agent-5',
              name: 'Market Oracle',
              description: 'Predictive modeling for cryptocurrency and stock markets.',
              explanation: 'Relevant to your interest in finance and trading.',
              topFeatures: ['Real-time feeds', 'Sentiment analysis', 'Risk scoring'],
              rating: 4.5,
              users: 850,
            }
          ];

          const userVector = getUserVector();
          
          if (Object.keys(userVector).length === 0) {
            // No interaction data, return default trending
            resolve(allAgents.slice(0, 3));
            return;
          }

          // Score agents
          const scoredAgents = allAgents.map(agent => {
            const agentText = `${agent.name} ${agent.description} ${agent.topFeatures.join(' ')}`;
            const agentVector = extractTextVector(agentText);
            const score = cosineSimilarity(userVector, agentVector);
            return { agent, score };
          });

          // Sort by score descending
          scoredAgents.sort((a, b) => b.score - a.score);

          // Return top 3
          resolve(scoredAgents.slice(0, 3).map(sa => sa.agent));
        }, 300);
      });
    } catch (error) {
      console.error('Error fetching recommendations:', error);
      return [];
    }
  },

  sendFeedback: async (feedback: FeedbackData): Promise<boolean> => {
    try {
      console.log('Sending feedback to backend:', feedback);
      // In a real app, use fetch('/api/recommendations/feedback', { method: 'POST', body: JSON.stringify(feedback) })
      return new Promise((resolve) => {
        setTimeout(() => resolve(true), 500);
      });
    } catch (error) {
      console.error('Error sending feedback:', error);
      return false;
    }
  },
};
