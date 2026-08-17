export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      activity_events: {
        Row: {
          created_at: string
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          metadata_redacted_json: Json
          occurred_at: string
          summary: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          metadata_redacted_json?: Json
          occurred_at?: string
          summary: string
          user_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          metadata_redacted_json?: Json
          occurred_at?: string
          summary?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_conversations: {
        Row: {
          context_type: string
          created_at: string
          entity_id: string | null
          id: string
          user_id: string
        }
        Insert: {
          context_type: string
          created_at?: string
          entity_id?: string | null
          id?: string
          user_id: string
        }
        Update: {
          context_type?: string
          created_at?: string
          entity_id?: string | null
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_interactions: {
        Row: {
          created_at: string
          feedback_category: string | null
          helpful: boolean | null
          id: string
          input_classification: string | null
          latency_ms: number
          model: string
          output_schema_version: number
          policy_version: number
          prompt_version: number
          purpose: string
          records_referenced: Json
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          feedback_category?: string | null
          helpful?: boolean | null
          id?: string
          input_classification?: string | null
          latency_ms: number
          model: string
          output_schema_version: number
          policy_version: number
          prompt_version: number
          purpose: string
          records_referenced?: Json
          status: string
          user_id: string
        }
        Update: {
          created_at?: string
          feedback_category?: string | null
          helpful?: boolean | null
          id?: string
          input_classification?: string | null
          latency_ms?: number
          model?: string
          output_schema_version?: number
          policy_version?: number
          prompt_version?: number
          purpose?: string
          records_referenced?: Json
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_messages: {
        Row: {
          content_encrypted: string
          conversation_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          content_encrypted: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          content_encrypted?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_data_categories: {
        Row: {
          asset_id: string
          category: string
          confidence: string
          created_at: string
          description: string | null
          id: string
          sensitivity: string | null
          source: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asset_id: string
          category: string
          confidence?: string
          created_at?: string
          description?: string | null
          id?: string
          sensitivity?: string | null
          source?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asset_id?: string
          category?: string
          confidence?: string
          created_at?: string
          description?: string | null
          id?: string
          sensitivity?: string | null
          source?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_data_categories_asset_fkey"
            columns: ["user_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "digital_assets"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
      asset_permissions: {
        Row: {
          asset_id: string
          created_at: string
          id: string
          last_verified_at: string | null
          permission_type: string
          scope: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          id?: string
          last_verified_at?: string | null
          permission_type: string
          scope: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          id?: string
          last_verified_at?: string | null
          permission_type?: string
          scope?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_permissions_asset_fkey"
            columns: ["user_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "digital_assets"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
      audit_events: {
        Row: {
          actor_type: string
          context_json: Json
          created_at: string
          entity_id: string | null
          entity_type: string | null
          event_hash: string
          event_type: string
          id: string
          occurred_at: string
          prev_hash: string
          subject_ref: string
        }
        Insert: {
          actor_type: string
          context_json?: Json
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_hash: string
          event_type: string
          id?: string
          occurred_at?: string
          prev_hash: string
          subject_ref: string
        }
        Update: {
          actor_type?: string
          context_json?: Json
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_hash?: string
          event_type?: string
          id?: string
          occurred_at?: string
          prev_hash?: string
          subject_ref?: string
        }
        Relationships: []
      }
      consents: {
        Row: {
          consent_type: string
          granted: boolean
          id: string
          policy_version: string
          recorded_at: string
          user_id: string
        }
        Insert: {
          consent_type: string
          granted: boolean
          id?: string
          policy_version: string
          recorded_at?: string
          user_id: string
        }
        Update: {
          consent_type?: string
          granted?: boolean
          id?: string
          policy_version?: string
          recorded_at?: string
          user_id?: string
        }
        Relationships: []
      }
      digital_assets: {
        Row: {
          account_identifier_encrypted: string | null
          category: string
          confidence: string
          created_at: string
          id: string
          last_verified_at: string | null
          metadata_json: Json
          notes: string | null
          service_domain: string | null
          service_name: string
          source_label: string | null
          source_type: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_identifier_encrypted?: string | null
          category: string
          confidence?: string
          created_at?: string
          id?: string
          last_verified_at?: string | null
          metadata_json?: Json
          notes?: string | null
          service_domain?: string | null
          service_name: string
          source_label?: string | null
          source_type?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_identifier_encrypted?: string | null
          category?: string
          confidence?: string
          created_at?: string
          id?: string
          last_verified_at?: string | null
          metadata_json?: Json
          notes?: string | null
          service_domain?: string | null
          service_name?: string
          source_label?: string | null
          source_type?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      idempotency_keys: {
        Row: {
          completed_at: string | null
          created_at: string
          expires_at: string
          id: string
          idempotency_key: string
          result_encrypted: string | null
          result_hash: string | null
          scope: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          idempotency_key: string
          result_encrypted?: string | null
          result_hash?: string | null
          scope: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          idempotency_key?: string
          result_encrypted?: string | null
          result_hash?: string | null
          scope?: string
          user_id?: string
        }
        Relationships: []
      }
      privacy_findings: {
        Row: {
          asset_id: string | null
          confidence: string
          created_at: string
          dedup_key: string
          description: string
          evidence_refs_json: Json
          evidence_summary: string
          finding_type: string
          id: string
          input_hash: string | null
          recommended_action: string
          resolution_action: string | null
          resolved_at: string | null
          resolved_by: string | null
          rule_id: string | null
          rule_version: string | null
          severity: string
          source_reference: string | null
          source_type: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asset_id?: string | null
          confidence?: string
          created_at?: string
          dedup_key: string
          description: string
          evidence_refs_json?: Json
          evidence_summary: string
          finding_type: string
          id?: string
          input_hash?: string | null
          recommended_action: string
          resolution_action?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          rule_id?: string | null
          rule_version?: string | null
          severity: string
          source_reference?: string | null
          source_type?: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asset_id?: string | null
          confidence?: string
          created_at?: string
          dedup_key?: string
          description?: string
          evidence_refs_json?: Json
          evidence_summary?: string
          finding_type?: string
          id?: string
          input_hash?: string | null
          recommended_action?: string
          resolution_action?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          rule_id?: string | null
          rule_version?: string | null
          severity?: string
          source_reference?: string | null
          source_type?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "privacy_findings_asset_fkey"
            columns: ["user_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "digital_assets"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
      privacy_score_snapshots: {
        Row: {
          factor_breakdown_json: Json
          id: string
          is_demo: boolean
          reason: string
          recorded_at: string
          score: number
          score_version: string
          user_id: string
        }
        Insert: {
          factor_breakdown_json?: Json
          id?: string
          is_demo?: boolean
          reason: string
          recorded_at?: string
          score: number
          score_version: string
          user_id: string
        }
        Update: {
          factor_breakdown_json?: Json
          id?: string
          is_demo?: boolean
          reason?: string
          recorded_at?: string
          score?: number
          score_version?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          demo_data_enabled: boolean
          display_name: string | null
          id: string
          locale: string
          onboarding_completed_at: string | null
          onboarding_state_json: Json
          privacy_goal: string | null
          selected_categories: string[]
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          demo_data_enabled?: boolean
          display_name?: string | null
          id: string
          locale?: string
          onboarding_completed_at?: string | null
          onboarding_state_json?: Json
          privacy_goal?: string | null
          selected_categories?: string[]
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          demo_data_enabled?: boolean
          display_name?: string | null
          id?: string
          locale?: string
          onboarding_completed_at?: string | null
          onboarding_state_json?: Json
          privacy_goal?: string | null
          selected_categories?: string[]
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_encryption_keys: {
        Row: {
          created_at: string
          destroyed_at: string | null
          id: string
          kek_version: number
          status: string
          updated_at: string
          user_id: string
          wrapped_dek: string | null
        }
        Insert: {
          created_at?: string
          destroyed_at?: string | null
          id?: string
          kek_version: number
          status?: string
          updated_at?: string
          user_id: string
          wrapped_dek?: string | null
        }
        Update: {
          created_at?: string
          destroyed_at?: string | null
          id?: string
          kek_version?: number
          status?: string
          updated_at?: string
          user_id?: string
          wrapped_dek?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

