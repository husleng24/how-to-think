use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorCode {
    InvalidRequest,
    ProviderNotConfigured,
    ProviderDisabled,
    ProviderConfigInvalid,
    ProviderUnavailable,
    ProviderTimedOut,
    ProviderCancelled,
    ProviderNonZeroExit,
    ProviderOutputMalformed,
    ProviderOutputTooLarge,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub code: AiErrorCode,
    pub message: String,
    pub recoverable: bool,
    pub guidance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AiError {
    pub fn new(
        code: AiErrorCode,
        message: impl Into<String>,
        recoverable: bool,
        guidance: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            recoverable,
            guidance: guidance.into(),
            provider_id: None,
            run_id: None,
            exit_code: None,
            detail: None,
        }
    }

    pub fn with_provider_id(mut self, provider_id: impl Into<String>) -> Self {
        self.provider_id = Some(provider_id.into());
        self
    }

    pub fn with_run_id(mut self, run_id: impl Into<String>) -> Self {
        self.run_id = Some(run_id.into());
        self
    }

    pub fn with_exit_code(mut self, exit_code: Option<i32>) -> Self {
        self.exit_code = exit_code;
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}
